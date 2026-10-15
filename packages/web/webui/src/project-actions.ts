/**
 * A project action in flight (create, remove, rebuild the container).
 *
 * The server answers all three the same way: an `error` message when it refuses, and
 * a `projects` broadcast when it succeeds. A form that awaits one has to be released
 * by the broadcast too. Waiting only for the error left the form in its busy state
 * for the whole timeout after a success, and the project picker renders its list
 * behind that form — so a project that had just been created looked like nothing
 * happened until the page was reloaded.
 */
export class ProjectAction {
	private pending: ((message: string | null) => void) | null = null;

	/** Run `send`, resolving with the server's error message or null on success. */
	run(send: () => void, timeoutMs = 60000): Promise<string | null> {
		return new Promise<string | null>((resolve) => {
			this.pending = resolve;
			send();
			setTimeout(() => {
				// Only give up on this action; a later one may own the slot by now.
				if (this.pending !== resolve) return;
				this.pending = null;
				resolve(null);
			}, timeoutMs);
		});
	}

	/** The server refused the action: release the form with its reason. */
	failed(message: string): void {
		this.release(message);
	}

	/** The server broadcast the new project list: the action succeeded. */
	succeeded(): void {
		this.release(null);
	}

	private release(message: string | null): void {
		const resolve = this.pending;
		this.pending = null;
		resolve?.(message);
	}
}
