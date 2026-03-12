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

    private readonly filePaths: string[];

    private watchers: fs.FSWatcher[] = [];

    private previousStats: Record<string, FileStat> = {};

    private watchedFileNames: Record<string, string[]> = {};

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

            if (!watchedDirectories.has(directory)) {
                watchedDirectories.add(directory);
                this.watchDirectory(directory);
            }
        }
    }

    private watchDirectory(directory: string) {
        const watcher = fs.watch(directory, { encoding: "utf8", persistent: false, recursive: false });
        watcher.on("change", async (_, fileName) => {
            const trackedFiles = this.watchedFileNames[directory] ?? [];
            const changedFileName = typeof fileName === "string" ? fileName : null;
            const targets = changedFileName
                ? trackedFiles.filter(item => item === changedFileName)
                : trackedFiles;

            for (const target of targets) {
                await this.handleFileEvent(path.join(directory, target));
            }
        });

        watcher.on("error", error => {
            this.emit("error", error);
        });

        this.watchers.push(watcher);
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

    private isSameStat(prevStat: FileStat, currentStat: FileStat) {
        if (!prevStat && !currentStat) return true;
        if (!prevStat || !currentStat) return false;

        return prevStat.mtimeMs === currentStat.mtimeMs && prevStat.size === currentStat.size;
    }

    stop() {
        for (const watcher of this.watchers) {
            watcher.close();
        }
    }
}
