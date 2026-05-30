/**
 * Transaction manager handling lock queuing and savepoint-based nested transactions.
 */
export class TransactionManager {
    public isInTransaction = false;
    public savepointStack: string[] = [];
    private lockQueue: Array<() => void> = [];
    private lockHeld = false;

    async acquireLock(): Promise<void> {
        if (!this.lockHeld) {
            this.lockHeld = true;
            return;
        }
        return new Promise((resolve) => {
            this.lockQueue.push(resolve);
        });
    }

    releaseLock(): void {
        const next = this.lockQueue.shift();
        if (next) {
            next();
        } else {
            this.lockHeld = false;
        }
    }

    isNested(): boolean {
        return this.isInTransaction || this.savepointStack.length > 0;
    }

    pushSavepoint(): string {
        const name = `sp_${crypto.randomUUID().replace(/-/g, '_')}`;
        this.savepointStack.push(name);
        return name;
    }

    popSavepoint(): void {
        this.savepointStack.pop();
    }

    markTransactionStarted(): void {
        this.isInTransaction = true;
    }

    markTransactionEnded(): void {
        this.isInTransaction = false;
    }
}
