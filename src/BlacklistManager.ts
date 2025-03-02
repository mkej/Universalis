import { Collection, Db, MongoError } from "mongodb";

export interface BlacklistEntry {
    uploaderID: string;
}

export class BlacklistManager {
    public static async create(db: Db): Promise<BlacklistManager> {
        const collection = db.collection("blacklist");
        await collection.createIndexes([
            { key: { uploaderID: 1 }, unique: true }
        ]);
        return new BlacklistManager(collection);
    }

    private collection: Collection<BlacklistEntry>;

    private constructor(collection: Collection<BlacklistEntry>) {
        this.collection = collection;
    }

    /** Add an uploader to the blacklist, preventing their data from being processed. */
    public async add(uploaderID: string): Promise<void> {
        try {
            await this.collection.insertOne({ uploaderID });
        } catch (e) {
            if ((e as MongoError).code !== 11000) throw e;
        }
    }

    /** Check if the blacklist has an uploader. */
    public async has(uploaderID: string): Promise<boolean> {
        return await this.collection.findOne({ uploaderID }) != null;
    }
}
