import { pool } from '../config/database';
import { generateReferenceNumber } from '../utils/referenceGenerator';

export enum TransactionStatus {
  Pending = 'pending',
  Completed = 'completed',
  Failed = 'failed',
  Cancelled = 'cancelled',
}

// NEW: distinguishes native XLM from anchored assets (USDC, etc.)
export enum AssetType {
  XLM = 'xlm',
  Anchored = 'anchored',
}

const MAX_TAGS = 10;
const TAG_REGEX = /^[a-z0-9-]+$/;

function validateTags(tags: string[]): void {
  if (tags.length > MAX_TAGS) throw new Error(`Maximum ${MAX_TAGS} tags allowed`);
  for (const tag of tags) {
    if (!TAG_REGEX.test(tag)) throw new Error(`Invalid tag format: "${tag}"`);
  }
}

export interface Transaction {
  id: string;
  referenceNumber: string;
  type: 'deposit' | 'withdraw';
  amount: string;
  phoneNumber: string;
  provider: string;
  stellarAddress: string;
  status: TransactionStatus;
  // NEW fields
  assetType: AssetType;
  assetCode?: string;   // e.g. 'USDC' — only for anchored assets
  assetIssuer?: string; // issuer address — only for anchored assets
  tags: string[];
  createdAt: Date;
}

export class TransactionModel {
  async create(
    data: Omit<Transaction, 'id' | 'referenceNumber' | 'createdAt'>
  ): Promise<Transaction> {
    const tags = data.tags ?? [];
    validateTags(tags);

    // XLM transactions must not carry assetCode/assetIssuer
    if (data.assetType === AssetType.XLM && (data.assetCode || data.assetIssuer)) {
      throw new Error('Native XLM transactions must not specify assetCode or assetIssuer');
    }

    // Anchored assets must carry both assetCode and assetIssuer
    if (data.assetType === AssetType.Anchored && (!data.assetCode || !data.assetIssuer)) {
      throw new Error('Anchored asset transactions must specify both assetCode and assetIssuer');
    }

    const referenceNumber = await generateReferenceNumber();

    const result = await pool.query(
      `INSERT INTO transactions
         (reference_number, type, amount, phone_number, provider,
          stellar_address, status, asset_type, asset_code, asset_issuer, tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        referenceNumber,
        data.type,
        data.amount,
        data.phoneNumber,
        data.provider,
        data.stellarAddress,
        data.status,
        data.assetType,
        data.assetCode ?? null,
        data.assetIssuer ?? null,
        tags,
      ]
    );
    return result.rows[0];
  }

  async findById(id: string): Promise<Transaction | null> {
    const result = await pool.query(
      'SELECT * FROM transactions WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  async updateStatus(id: string, status: TransactionStatus): Promise<Transaction> {
    // FIXED: was returning void, now returns the updated row
    // so cancelTransactionHandler can use the result directly
    const result = await pool.query(
      'UPDATE transactions SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );
    return result.rows[0];
  }

  async findByReferenceNumber(referenceNumber: string): Promise<Transaction | null> {
    const result = await pool.query(
      'SELECT * FROM transactions WHERE reference_number = $1',
      [referenceNumber]
    );
    return result.rows[0] || null;
  }

  // NEW: find all XLM transactions — useful for payment monitoring
  async findByAssetType(assetType: AssetType): Promise<Transaction[]> {
    const result = await pool.query(
      'SELECT * FROM transactions WHERE asset_type = $1 ORDER BY created_at DESC',
      [assetType]
    );
    return result.rows;
  }

  // NEW: query XLM balance for a Stellar address
  // Kept separate from anchored balance queries — no trustline involved
  async findXlmTransactionsByAddress(stellarAddress: string): Promise<Transaction[]> {
    const result = await pool.query(
      `SELECT * FROM transactions
       WHERE stellar_address = $1
         AND asset_type = $2
       ORDER BY created_at DESC`,
      [stellarAddress, AssetType.XLM]
    );
    return result.rows;
  }

  async findByTags(tags: string[]): Promise<Transaction[]> {
    validateTags(tags);
    const result = await pool.query(
      'SELECT * FROM transactions WHERE tags @> $1',
      [tags]
    );
    return result.rows;
  }

  async addTags(id: string, tags: string[]): Promise<Transaction | null> {
    validateTags(tags);
    const result = await pool.query(
      `UPDATE transactions
       SET tags = (
         SELECT ARRAY(SELECT DISTINCT unnest(tags || $1::TEXT[]))
         FROM transactions WHERE id = $2
       )
       WHERE id = $2
         AND cardinality(ARRAY(SELECT DISTINCT unnest(tags || $1::TEXT[]))) <= ${MAX_TAGS}
       RETURNING *`,
      [tags, id]
    );
    return result.rows[0] || null;
  }

  async removeTags(id: string, tags: string[]): Promise<Transaction | null> {
    const result = await pool.query(
      `UPDATE transactions
       SET tags = ARRAY(SELECT unnest(tags) EXCEPT SELECT unnest($1::TEXT[]))
       WHERE id = $2
       RETURNING *`,
      [tags, id]
    );
    return result.rows[0] || null;
  }
}