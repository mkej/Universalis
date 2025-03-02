// Dependencies
import cors from "@koa/cors";
import Router from "@koa/router";
import difference from "lodash.difference";
import Koa from "koa";
import bodyParser from "koa-bodyparser";
import serve from "koa-static";
import { MongoClient } from "mongodb";
import sha from "sha.js";
import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";

import { BlacklistManager } from "./BlacklistManager";
import { ContentIDCollection } from "./ContentIDCollection";
import { CronJobManager } from "./CronJobManager";
import { ExtraDataManager } from "./ExtraDataManager";
import { RemoteDataManager } from "./RemoteDataManager";
import validation from "./validate";

// Scripts
// import createGarbageData from "../scripts/createGarbageData";
// createGarbageData();

// Load models
import { Collection } from "mongodb";

import { CharacterContentIDUpload } from "./models/CharacterContentIDUpload";
import { City } from "./models/City";
import { DailyUploadStatistics } from "./models/DailyUploadStatistics";
import { MarketBoardHistoryEntry } from "./models/MarketBoardHistoryEntry";
import { MarketBoardItemListing } from "./models/MarketBoardItemListing";
import { MarketBoardListingsUpload } from "./models/MarketBoardListingsUpload";
import { MarketBoardSaleHistoryUpload } from "./models/MarketBoardSaleHistoryUpload";
import { RecentlyUpdated } from "./models/RecentlyUpdated";
import { TrustedSource } from "./models/TrustedSource";
import { WorldItemPairList } from "./models/WorldItemPairList";

import { HistoryTracker } from "./trackers/HistoryTracker";
import { PriceTracker } from "./trackers/PriceTracker";
import { TrustedSourceManager } from "./TrustedSourceManager";

// Define application and its resources
const logger = winston.createLogger({
    transports: [
        new (DailyRotateFile)({
            datePattern: "YYYY-MM-DD-HH",
            filename: "logs/universalis-%DATE%.log",
            maxSize: "20m"
        }),
        new winston.transports.File({
            filename: "logs/error.log",
            level: "error"
        }),
        new winston.transports.Console({
            format: winston.format.simple()
        })
    ]
});
logger.info("Process started.");

const db = MongoClient.connect("mongodb://localhost:27017/", { useNewUrlParser: true, useUnifiedTopology: true });

var blacklistManager: BlacklistManager;
var contentIDCollection: ContentIDCollection;
var extendedHistory: Collection;
var extraDataManager: ExtraDataManager;
var historyTracker: HistoryTracker;
var priceTracker: PriceTracker;
var recentData: Collection;
var remoteDataManager: RemoteDataManager;
var trustedSourceManager: TrustedSourceManager;

const worldMap = new Map();

const init = (async () => {
    // DB Data Managers
    const universalisDB = (await db).db("universalis");

    const contentCollection = universalisDB.collection("content");
    extendedHistory = universalisDB.collection("extendedHistory");
    const extraData = universalisDB.collection("extraData");
    recentData = universalisDB.collection("recentData");

    blacklistManager = await BlacklistManager.create(universalisDB);
    contentIDCollection = new ContentIDCollection(contentCollection);
    extraDataManager = new ExtraDataManager(extraData, recentData);
    historyTracker = new HistoryTracker(recentData, extendedHistory);
    priceTracker = new PriceTracker(recentData);
    remoteDataManager = new RemoteDataManager({ logger });
    remoteDataManager.fetchAll();
    trustedSourceManager = await TrustedSourceManager.create(universalisDB);

    // World-ID conversions
    const worldList = await remoteDataManager.parseCSV("World.csv");
	for (let worldEntry of worldList) {
        if (worldEntry[0] == "25") continue;
	    worldMap.set(worldEntry[1], parseInt(worldEntry[0]));
	}

    logger.info("Connected to database and started data managers.");
})();

const universalis = new Koa();
universalis.use(cors());
universalis.use(bodyParser({
    enableTypes: ["json"],
    jsonLimit: "3mb"
}));

// Logging
universalis.use(async (ctx, next) => {
    console.log(`${ctx.method} ${ctx.url}`);
    await next();
});

// Get query parameters
universalis.use(async (ctx, next) => {
    const queryParameters: string[] = ctx.url.substr(ctx.url.indexOf("?")).split(/[?&]+/g).slice(1);
    ctx.queryParameters = {};
    if (queryParameters) {
        for (let param of queryParameters) {
            const keyValuePair = param.split(/[^a-zA-Z0-9]+/g);
            ctx.queryParameters[keyValuePair[0]] = keyValuePair[1];
        }
    }
    await next();
});

// Publish public resources
universalis.use(serve("./public"));

// Routing
const router = new Router();

router.get("/api/:world/:item", async (ctx) => { // Normal data
    await init;

    const itemIDs: number[] = ctx.params.item.split(",").map((id) => {
        return parseInt(id);
    });

    // Query construction
    const query = { itemID: { $in: itemIDs } };
    const worldName = ctx.params.world.charAt(0).toUpperCase() + ctx.params.world.substr(1);
    if (!parseInt(ctx.params.world) && !worldMap.get(worldName)) {
        query["dcName"] = ctx.params.world;
    } else {
        if (parseInt(ctx.params.world)) {
            query["worldID"] = parseInt(ctx.params.world);
        } else {
            query["worldID"] = worldMap.get(worldName);
        }
    }

    // Request database info
    let data = {
        itemIDs,
        items: await recentData.find(query, { projection: { _id: 0, uploaderID: 0 } }).toArray()
    };

    if (!parseInt(ctx.params.world) && !worldMap.get(worldName)) {
        data["dcName"] = ctx.params.world;
    } else {
        if (parseInt(ctx.params.world)) {
            data["worldID"] = parseInt(ctx.params.world);
        } else {
            data["worldID"] = worldMap.get(worldName);
        }
    }

    // Fill in unresolved items
    const resolvedItems: number[] = data.items.map((item) => item.itemID);
    const unresolvedItems: number[] = difference(itemIDs, resolvedItems);
    data["unresolvedItems"] = unresolvedItems;

    for (const item of unresolvedItems) {
        const unresolvedItemData = {
            itemID: item,
            lastUploadTime: 0,
            listings: [],
            recentHistory: []
        };
        if (!parseInt(ctx.params.world) && !worldMap.get(worldName)) {
            unresolvedItemData["dcName"] = ctx.params.world;
        } else {
            if (parseInt(ctx.params.world)) {
                unresolvedItemData["worldID"] = parseInt(ctx.params.world);
            } else {
                unresolvedItemData["worldID"] = worldMap.get(worldName);
            }
        }
        data.items.push(unresolvedItemData);
    }

    // If only one item is requested we just turn the whole thing into the one item.
    if (data.itemIDs.length === 1) {
        data = data.items[0];
    } else if (!unresolvedItems) {
        delete data["unresolvedItems"];
    }

    ctx.body = data;
});

router.get("/api/history/:world/:item", async (ctx) => { // Extended history
    await init;

    let entriesToReturn: any = ctx.queryParameters.entries;
    if (entriesToReturn) entriesToReturn = parseInt(entriesToReturn.replace(/[^0-9]/g, ""));

    const itemIDs: number[] = ctx.params.item.split(",").map((id) => {
        return parseInt(id);
    });

    // Query construction
    const query = { itemID: { $in: itemIDs } };
    const worldName = ctx.params.world.charAt(0).toUpperCase() + ctx.params.world.substr(1);
    if (!parseInt(ctx.params.world) && !worldMap.get(worldName)) {
        query["dcName"] = ctx.params.world;
    } else {
        if (parseInt(ctx.params.world)) {
            query["worldID"] = parseInt(ctx.params.world);
        } else {
            query["worldID"] = worldMap.get(worldName);
        }
    }

    // Request database info
    let data = {
        itemIDs,
        items: await extendedHistory.find(query, {
            projection: { _id: 0, uploaderID: 0 }
        }).toArray()
    };

    if (!parseInt(ctx.params.world) && !worldMap.get(worldName)) {
        data["dcName"] = ctx.params.world;
    } else {
        if (parseInt(ctx.params.world)) {
            data["worldID"] = parseInt(ctx.params.world);
        } else {
            data["worldID"] = worldMap.get(worldName);
        }
    }

    // Data filtering
    data.items = data.items.map((item) => {
        if (entriesToReturn) item.entries = item.entries.slice(0, Math.min(500, entriesToReturn));
        item.entries = item.entries.map((entry) => {
            delete entry.uploaderID;
            return entry;
        });
        if (!item.lastUploadTime) item.lastUploadTime = 0;
        return item;
    });

    // Fill in unresolved items
    const resolvedItems: number[] = data.items.map((item) => item.itemID);
    const unresolvedItems: number[] = difference(itemIDs, resolvedItems);
    data["unresolvedItems"] = unresolvedItems;

    for (const item of unresolvedItems) {
        const unresolvedItemData = {
            entries: [],
            itemID: item,
            lastUploadTime: 0
        };
        if (!parseInt(ctx.params.world) && !worldMap.get(worldName)) {
            unresolvedItemData["dcName"] = ctx.params.world;
        } else {
            if (parseInt(ctx.params.world)) {
                unresolvedItemData["worldID"] = parseInt(ctx.params.world);
            } else {
                unresolvedItemData["worldID"] = worldMap.get(worldName);
            }
        }

        data.items.push(unresolvedItemData);
    }

    // If only one item is requested we just turn the whole thing into the one item.
    if (data.itemIDs.length === 1) {
        data = data.items[0];
    } else if (!unresolvedItems) {
        delete data["unresolvedItems"];
    }

    ctx.body = data;
});

router.get("/api/extra/content/:contentID", async (ctx) => { // Content IDs
    await init;

    const content = contentIDCollection.get(ctx.params.contentID);

    if (!content) {
        ctx.body = {};
        return;
    }

    ctx.body = content;
});

router.get("/api/extra/stats/upload-history", async (ctx) => { // Upload rate
    await init;

    let daysToReturn: any = ctx.queryParameters.entries;
    if (daysToReturn) daysToReturn = parseInt(daysToReturn.replace(/[^0-9]/g, ""));

    const data: DailyUploadStatistics = await extraDataManager.getDailyUploads(daysToReturn);

    if (!data) {
        ctx.body = {
            uploadCountByDay: []
        } as DailyUploadStatistics;
        return;
    }

    ctx.body = data;
});

router.get("/api/extra/stats/recently-updated", async (ctx) => { // Recently updated items
    await init;

    let entriesToReturn: any = ctx.queryParameters.entries;
    if (entriesToReturn) entriesToReturn = parseInt(entriesToReturn.replace(/[^0-9]/g, ""));

    const data: RecentlyUpdated = await extraDataManager.getRecentlyUpdatedItems(entriesToReturn);

    if (!data) {
        ctx.body = {
            items: []
        } as RecentlyUpdated;
        return;
    }

    ctx.body = data;
});

router.get("/api/extra/stats/least-recently-updated", async (ctx) => { // Recently updated items
    await init;

    let entriesToReturn: any = ctx.queryParameters.entries;
    if (entriesToReturn) entriesToReturn = parseInt(entriesToReturn.replace(/[^0-9]/g, ""));

    const data: WorldItemPairList = await extraDataManager.getLeastRecentlyUpdatedItems(entriesToReturn);

    if (!data) {
        ctx.body = {
            items: []
        } as WorldItemPairList;
        return;
    }

    ctx.body = data;
});

router.post("/upload/:apiKey", async (ctx) => { // Kinda like a main loop
    let err = validation.validateUploadDataPreCast(ctx);
    if (err) {
        return err;
    }

    await init;

    const promises: Array<Promise<any>> = []; // Sort of like a thread list.

    // Accept identity via API key.
    const trustedSource: TrustedSource = await trustedSourceManager.get(ctx.params.apiKey);
    if (!trustedSource) return ctx.throw(401);

    logger.info("Received upload from " + trustedSource.sourceName + ":\n" + JSON.stringify(ctx.request.body));

    promises.push(trustedSourceManager.increaseUploadCount(ctx.params.apiKey));
    promises.push(extraDataManager.incrementDailyUploads());

    // Data processing
    if (ctx.request.body.retainerCity) ctx.request.body.retainerCity = City[ctx.request.body.retainerCity];
    const uploadData:
        CharacterContentIDUpload &
        MarketBoardListingsUpload &
        MarketBoardSaleHistoryUpload
        = ctx.request.body;

    uploadData.uploaderID = sha("sha256").update(uploadData.uploaderID + "").digest("hex");

    err = await validation.validateUploadData(ctx, uploadData, blacklistManager);
    if (err) {
        return err;
    }

    // Hashing and passing data
    if (uploadData.listings) {
        const dataArray: MarketBoardItemListing[] = [];
        uploadData.listings = uploadData.listings.map((listing) => {
            const newListing = {
                creatorID: sha("sha256").update(listing.creatorID + "").digest("hex"),
                creatorName: listing.creatorName,
                hq: typeof listing.hq === "undefined" ? false : listing.hq,
                lastReviewTime: listing.lastReviewTime,
                listingID: sha("sha256").update(listing.listingID + "").digest("hex"),
                materia: typeof listing.materia === "undefined" ? [] : listing.materia,
                onMannequin: typeof listing.onMannequin === "undefined" ? false : listing.onMannequin,
                pricePerUnit: listing.pricePerUnit,
                quantity: listing.quantity,
                retainerCity: typeof listing.retainerCity === "number" ? listing.retainerCity : City[listing.retainerCity],
                retainerID: sha("sha256").update(listing.retainerID + "").digest("hex"),
                retainerName: listing.retainerName,
                sellerID: sha("sha256").update(listing.sellerID + "").digest("hex"),
                stainID: listing.stainID
            };

            if (listing.creatorID && listing.creatorName) {
                contentIDCollection.set(newListing.creatorID, "player", {
                    characterName: newListing.creatorName
                });
            }

            if (listing.retainerID && listing.retainerName) {
                contentIDCollection.set(newListing.retainerID, "retainer", {
                    characterName: newListing.retainerName
                });
            }

            return newListing;
        });

        for (const listing of uploadData.listings) {
            listing.total = listing.pricePerUnit * listing.quantity;
            dataArray.push(listing as any);
        }

        promises.push(priceTracker.set(
            uploadData.uploaderID,
            uploadData.itemID,
            uploadData.worldID,
            dataArray as MarketBoardItemListing[]
        ));
    }

    if (uploadData.entries) {
        const dataArray: MarketBoardHistoryEntry[] = [];
        uploadData.entries = uploadData.entries.map((entry) => {
            return {
                buyerName: entry.buyerName,
                hq: entry.hq,
                pricePerUnit: entry.pricePerUnit,
                quantity: entry.quantity,
                sellerID: sha("sha256").update(entry.sellerID + "").digest("hex"),
                timestamp: entry.timestamp
            };
        });

        for (const entry of uploadData.entries) {
            entry.total = entry.pricePerUnit * entry.quantity;
            dataArray.push(entry);
        }

        promises.push(historyTracker.set(
            uploadData.uploaderID,
            uploadData.itemID,
            uploadData.worldID,
            dataArray as MarketBoardHistoryEntry[]
        ));
    }

    if (uploadData.itemID) {
        promises.push(extraDataManager.addRecentlyUpdatedItem(uploadData.itemID));
    }

    if (uploadData.contentID && uploadData.characterName) {
        uploadData.contentID = sha("sha256").update(uploadData.contentID + "").digest("hex");

        promises.push(contentIDCollection.set(uploadData.contentID, "player", {
            characterName: uploadData.characterName
        }));
    }

    await Promise.all(promises);

    ctx.body = "Success";
});

universalis.use(router.routes());

// Start server
const port = 4000;
universalis.listen(port);
logger.info(`Server started on port ${port}.`);
