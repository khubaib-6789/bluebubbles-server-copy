import EventEmitter from "events";
import fs from "fs";
import path from "path";

export type FileStat = fs.Stats | null | undefined;

export type FileChangeHandlerCallback = (event: FileChangeEvent) => Promise<void>;

export type FileChangeEvent = {
    currentStat: FileStat;
    prevStat: FileStat;
    filePath: string;
};

export class MultiFileWatcher extends EventEmitter {
    tag = "MultiFileWatcher";

    private static readonly FILE_STAT_INTERVAL_MS = 100;

    private static readonly FILE_EVENT_SETTLE_MS = 75;

    private readonly filePaths: string[];

    private watchers: fs.FSWatcher[] = [];

    private statWatchedFiles: string[] = [];

    private previousStats: Record<string, FileStat> = {};

    private watchedFileNames: Record<string, string[]> = {};

    private pendingFileChecks: Record<string, NodeJS.Timeout> = {};

    constructor(filePaths: string[]) {
        super();
        this.filePaths = filePaths;
    }

    start() {
        const watchedDirectories = new Set<string>();

        for (const filePath of this.filePaths) {
            const directory = path.dirname(filePath);
            const fileName = path.basename(filePath);

            if (!this.watchedFileNames[directory]) {
                this.watchedFileNames[directory] = [];
            }

            if (!this.watchedFileNames[directory].includes(fileName)) {
                this.watchedFileNames[directory].push(fileName);
            }

            this.previousStats[filePath] = this.safeStatSync(filePath);
            this.watchFileStats(filePath);

            if (!watchedDirectories.has(directory)) {
                watchedDirectories.add(directory);
                this.watchDirectory(directory);
            }
        }
    }

    private watchDirectory(directory: string) {
        const watcher = fs.watch(directory, { encoding: "utf8", persistent: false, recursive: false });
        watcher.on("change", (_, fileName) => {
            const trackedFiles = this.watchedFileNames[directory] ?? [];
            const changedFileName = typeof fileName === "string" ? fileName : null;
            const targets = changedFileName
                ? trackedFiles.filter(item => item === changedFileName)
                : trackedFiles;

            for (const target of targets) {
                this.queueFileEvent(path.join(directory, target));
            }
        });

        watcher.on("error", error => {
            this.emit("error", error);
        });

        this.watchers.push(watcher);
    }

    // macOS can miss SQLite WAL writes via fs.watch/FSEvents, so also poll file metadata directly.
    private watchFileStats(filePath: string) {
        fs.watchFile(
            filePath,
            { persistent: false, interval: MultiFileWatcher.FILE_STAT_INTERVAL_MS },
            (currentStat, prevStat) => {
                const current = this.normalizeWatchFileStat(currentStat);
                const prev = this.normalizeWatchFileStat(prevStat);

                if (this.isSameStat(prev, current)) return;

                this.emit("change", {
                    filePath,
                    prevStat: prev ? { ...prev } : prev,
                    currentStat: current ? { ...current } : current
                });

                this.previousStats[filePath] = current;
            }
        );

        this.statWatchedFiles.push(filePath);
    }

    // Wait for SQLite to finish the current burst of WAL activity before comparing file stats.
    private queueFileEvent(filePath: string) {
        const existingTimer = this.pendingFileChecks[filePath];
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        this.pendingFileChecks[filePath] = setTimeout(() => {
            delete this.pendingFileChecks[filePath];
            this.handleFileEvent(filePath).catch(error => {
                this.emit("error", error);
            });
        }, MultiFileWatcher.FILE_EVENT_SETTLE_MS);
    }

    private async handleFileEvent(filePath: string) {
        const currentStat = await this.safeStat(filePath);
        const prevStat = this.previousStats[filePath] ?? null;

        if (this.isSameStat(prevStat, currentStat)) return;

        this.emit("change", {
            filePath,
            prevStat: prevStat ? { ...prevStat } : prevStat,
            currentStat: currentStat ? { ...currentStat } : currentStat
        });

        this.previousStats[filePath] = currentStat;
    }

    private safeStatSync(filePath: string): FileStat {
        try {
            return fs.statSync(filePath);
        } catch (error: any) {
            if (error?.code === "ENOENT") return null;
            throw error;
        }
    }

    private async safeStat(filePath: string): Promise<FileStat> {
        try {
            return await fs.promises.stat(filePath);
        } catch (error: any) {
            if (error?.code === "ENOENT") return null;
            throw error;
        }
    }

    private normalizeWatchFileStat(stat: fs.Stats): FileStat {
        if (!stat) return null;

        // fs.watchFile uses a zeroed Stats object when a file does not exist.
        if (stat.nlink === 0 && stat.size === 0 && stat.mtimeMs === 0) {
            return null;
        }

        return stat;
    }

    private isSameStat(prevStat: FileStat, currentStat: FileStat) {
        if (!prevStat && !currentStat) return true;
        if (!prevStat || !currentStat) return false;

        return prevStat.mtimeMs === currentStat.mtimeMs && prevStat.size === currentStat.size;
    }

    stop() {
        for (const timer of Object.values(this.pendingFileChecks)) {
            clearTimeout(timer);
        }

        this.pendingFileChecks = {};

        for (const filePath of this.statWatchedFiles) {
            fs.unwatchFile(filePath);
        }

        this.statWatchedFiles = [];

        for (const watcher of this.watchers) {
            watcher.close();
        }
    }
}
