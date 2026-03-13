import fs from "fs";
import { MultiFileWatcher } from "@server/lib/MultiFileWatcher";
import { Loggable } from "@server/lib/logging/Loggable";
import { Sema } from "async-sema";
import { IMessageCache, IMessagePoller } from "../pollers";
import { MessageRepository } from "..";
import { waitMs } from "@server/helpers/utils";

export class IMessageListener extends Loggable {
    tag = "IMessageListener";

    stopped: boolean;

    filePaths: string[];

    watcher: MultiFileWatcher;

    repo: MessageRepository;

    processLock: Sema;

    pollers: IMessagePoller[];

    cache: IMessageCache;

    lastCheck = 0;

    changeTimer: NodeJS.Timeout | null = null;

    isProcessingChange = false;

    needsFollowUpPass = false;

    constructor({
        filePaths,
        repo,
        cache
    }: {
        filePaths: string[],
        repo: MessageRepository,
        cache: IMessageCache
    }) {
        super();

        this.filePaths = filePaths;
        this.repo = repo;
        this.pollers = [];
        this.cache = cache;
        this.stopped = false;
        this.processLock = new Sema(1);
    }

    stop() {
        this.stopped = true;
        this.changeTimer && clearTimeout(this.changeTimer);
        this.changeTimer = null;
        this.needsFollowUpPass = false;
        this.isProcessingChange = false;
        this.watcher?.stop();
        this.removeAllListeners();
    }

    addPoller(poller: IMessagePoller) {
        this.pollers.push(poller);
    }

    getEarliestModifiedDate() {
        let earliest = new Date();
        for (const filePath of this.filePaths) {
            if (!fs.existsSync(filePath)) continue;

            const stat = fs.statSync(filePath);
            if (stat.mtime < earliest) {
                earliest = stat.mtime;
            }
        }

        return earliest;
    }

    async start() {
        this.lastCheck = this.getEarliestModifiedDate().getTime() - 60000;
        this.stopped = false;

        // Perform an initial poll to kinda seed the cache.
        // We'll use the earliest modified date of the files to determine the initial poll date.
        // We'll also subtract 1 minute just to pre-load the cache with a little bit of data.
        await this.poll(new Date(this.lastCheck), false);

        this.watcher = new MultiFileWatcher(this.filePaths);
        this.watcher.on("change", () => {
            this.queueChangeEvent();
        });

        this.watcher.on("error", (error) => {
            this.log.error(`Failed to watch database files: ${this.filePaths.join(", ")}`);
            this.log.debug(`Error: ${error}`);
        });

        this.watcher.start();
    }

    // SQLite WAL writes can emit multiple filesystem events before the new row is queryable.
    // Queue a follow-up pass whenever more changes arrive while a debounce window or poll is active.
    private queueChangeEvent() {
        if (this.stopped) return;

        if (this.changeTimer || this.isProcessingChange) {
            this.needsFollowUpPass = true;
            return;
        }

        this.changeTimer = setTimeout(() => {
            this.changeTimer = null;
            this.flushQueuedChanges().catch(error => {
                this.log.error(`Error flushing queued change events: ${error}`);
            });
        }, 500);
    }

    private async flushQueuedChanges() {
        if (this.stopped || this.isProcessingChange) return;

        const shouldScheduleFollowUp = this.needsFollowUpPass;
        this.needsFollowUpPass = false;
        this.isProcessingChange = true;

        try {
            await this.handleChangeEvent();
        } finally {
            this.isProcessingChange = false;
        }

        if (shouldScheduleFollowUp || this.needsFollowUpPass) {
            this.needsFollowUpPass = false;
            this.queueChangeEvent();
        }
    }

    async handleChangeEvent() {
        await this.processLock.acquire();
        try {
            const now = Date.now();
            let prevTime = this.lastCheck;
    
            if (prevTime <= 0 || prevTime > now) {
                this.log.debug(`Previous time is invalid (${prevTime}), setting to now...`);
                prevTime = now;
            } else if (now - prevTime > 86400000) {
                this.log.debug(`Previous time is > 24 hours ago, setting to 24 hours ago...`);
                prevTime = now - 86400000;
            }
    
            let afterTime = prevTime - 30000;
            if (afterTime > now) {
                afterTime = now;
            }
            await this.poll(new Date(afterTime));
            this.lastCheck = now;
    
            this.cache.trimCaches();
            if (this.processLock.nrWaiting() > 0) {
                await waitMs(100);
            }
        } catch (error) {
            this.log.error(`Error handling change event: ${error}`);
        } finally {
            this.processLock.release();
        }
    }

    async poll(after: Date, emitResults = true) {
        for (const poller of this.pollers) {
            const results = await poller.poll(after);

            if (emitResults) {
                for (const result of results) {
                    this.emit(result.eventType, result.data);
                    await waitMs(10);
                }
            }
        }
    }
}
