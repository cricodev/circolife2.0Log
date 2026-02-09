
import mongoose from "mongoose";
import LogCategories  from "./enumConstants.js";

const LogSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    userName: { type: String, required: true },
    actionType: {
        type: String,
        enum: Object.values(LogCategories),
        required: true,
    },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", },
    assetId: { type: mongoose.Schema.Types.ObjectId, ref: "Asset" },
    assetName: { type: String },
    targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    targetUserName: { type: String },
    description: { type: String },
    metadata: {
        type: mongoose.Schema.Types.Mixed,
        default: {},
    },
    category: {
        type: String,
        enum: [
            "userActivity",
            "assetActivity",
            "schedulerActivity",
            "systemActivity",
        ],
        required: true,
    },
    logTimeStamped: { type: Date, required: true, default: new Date },
}, { timestamps: true });

LogSchema.index({ userId: 1, createdAt: -1 });
LogSchema.index({ assetId: 1, createdAt: -1 });
LogSchema.index({ actionType: 1 });
LogSchema.index({ category: 1 });

const Log = mongoose.model("Log", LogSchema);
export default Log
