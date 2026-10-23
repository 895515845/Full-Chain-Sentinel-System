/**
 * A `docker` stand-in for the console tests.
 *
 * The console refuses to run anything outside a project container, so tests need
 * a container backend. Rather than letting production code fall back to host
 * execution, the tests put a fake `docker` first on PATH: the subcommands the
 * console issues succeed, and `exec` runs the command on the host after
 * rewriting `/work` to the project work directory. That keeps the real code path
 * (including the container scripts in files.ts) under test without Docker.
 *
 * Container lifecycle is tracked per name, because stopping, starting and
 * removing containers is behaviour under test: `docker ps -a` reports what the
 * fake knows, while a container it never saw still counts as running, so tests
 * that never create one keep their previous meaning.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = `#!/bin/sh
# Test stand-in for docker. Only the subcommands the console issues are handled.
# With SENTINEL_FAKE_DOCKER_LOG set, every invocation is appended, so a test can assert
# what the console asked for (e.g. the flags a container was created with).
[ -n "\${SENTINEL_FAKE_DOCKER_LOG:-}" ] && printf '%s\\n' "$*" >> "$SENTINEL_FAKE_DOCKER_LOG"
state_dir="\${SENTINEL_FAKE_DOCKER_STATE:-}"

# Record a container's state: running, stopped, or removed.
mark() {
	[ -n "$state_dir" ] || return 0
	mkdir -p "$state_dir"
	printf '%s' "$1" > "$state_dir/$2"
}

# The container name is the last argument of start/stop/rm/inspect.
last_arg() {
	_last=""
	for _arg in "$@"; do _last="$_arg"; done
	printf '%s' "$_last"
}

cmd="$1"
shift
case "$cmd" in
	image|build) exit 0 ;;
	run)
		# docker run -d --name <name> ...: remember the new container as running.
		name=""
		prev=""
		for arg in "$@"; do
			[ "$prev" = "--name" ] && name="$arg"
			prev="$arg"
		done
		[ -n "$name" ] && mark running "$name"
		exit 0
		;;
	start) mark running "$(last_arg "$@")"; exit 0 ;;
	stop) mark stopped "$(last_arg "$@")"; exit 0 ;;
	rm) mark removed "$(last_arg "$@")"; exit 0 ;;
	inspect)
		target="$(last_arg "$@")"
		state=""
		[ -n "$state_dir" ] && [ -f "$state_dir/$target" ] && state=$(cat "$state_dir/$target")
		case "$state" in
			running) echo "true"; exit 0 ;;
			stopped) echo "false"; exit 0 ;;
			removed) echo "Error: No such container: $target" >&2; exit 1 ;;
			*) echo "true"; exit 0 ;;
		esac
		;;
	ps)
		[ -n "$state_dir" ] || exit 0
		[ -d "$state_dir" ] || exit 0
		for file in "$state_dir"/*; do
			[ -f "$file" ] || continue
			name=$(basename "$file")
			state=$(cat "$file")
			case "$state" in
				running) printf '%s\\t%s\\n' "$name" running ;;
				stopped) printf '%s\\t%s\\n' "$name" exited ;;
			esac
		done
		exit 0
		;;
	exec)
		[ "$1" = "-i" ] && shift
		# dockerBashOperations passes the session cwd as the exec working dir.
		[ "$1" = "-w" ] && shift 2
		shift
		# Remaining arguments: sh -c <script> zg <args...>
		shift 2
		script="$1"; shift
		[ "$1" = "zg" ] && shift
		root="\${SENTINEL_FAKE_WORKDIR:-/work}"
		script=$(printf '%s' "$script" | sed "s#/work#\${root}#g")
		# Rotate the positional parameters, rewriting each one.
		count=$#
		i=0
		while [ "$i" -lt "$count" ]; do
			arg="$1"; shift
			arg=$(printf '%s' "$arg" | sed "s#/work#\${root}#g")
			set -- "$@" "$arg"
			i=$((i + 1))
		done
		exec sh -c "$script" zg "$@"
		;;
	*) exit 0 ;;
esac
`;

export interface FakeDocker {
	/** Directory holding the fake executable. */
	dir: string;
	/** Restores PATH and the environment variables this helper set. */
	restore(): void;
}

/**
 * Install the fake docker under `root` and point the project layout at `root`:
 * `SENTINEL_PROJECTS_DIR` keeps project creation out of the operator's home, and
 * `SENTINEL_FAKE_WORKDIR` is what the fake rewrites `/work` to. Passing `logPath` records
 * every invocation there, one command line per call.
 */
export function installFakeDocker(root: string, workDir: string, logPath?: string): FakeDocker {
	const dir = join(root, "fake-docker");
	mkdirSync(dir, { recursive: true });
	const binary = join(dir, "docker");
	writeFileSync(binary, SCRIPT);
	chmodSync(binary, 0o755);

	const previousPath = process.env.PATH;
	const previousProjectsDir = process.env.SENTINEL_PROJECTS_DIR;
	const previousWorkDir = process.env.SENTINEL_FAKE_WORKDIR;
	const previousLog = process.env.SENTINEL_FAKE_DOCKER_LOG;
	const previousState = process.env.SENTINEL_FAKE_DOCKER_STATE;
	process.env.PATH = `${dir}:${previousPath ?? ""}`;
	process.env.SENTINEL_PROJECTS_DIR = join(root, "projects");
	process.env.SENTINEL_FAKE_WORKDIR = workDir;
	process.env.SENTINEL_FAKE_DOCKER_STATE = join(root, "fake-docker-state");
	if (logPath) process.env.SENTINEL_FAKE_DOCKER_LOG = logPath;

	return {
		dir,
		restore() {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			if (previousProjectsDir === undefined) delete process.env.SENTINEL_PROJECTS_DIR;
			else process.env.SENTINEL_PROJECTS_DIR = previousProjectsDir;
			if (previousWorkDir === undefined) delete process.env.SENTINEL_FAKE_WORKDIR;
			else process.env.SENTINEL_FAKE_WORKDIR = previousWorkDir;
			if (previousLog === undefined) delete process.env.SENTINEL_FAKE_DOCKER_LOG;
			else process.env.SENTINEL_FAKE_DOCKER_LOG = previousLog;
			if (previousState === undefined) delete process.env.SENTINEL_FAKE_DOCKER_STATE;
			else process.env.SENTINEL_FAKE_DOCKER_STATE = previousState;
		},
	};
}

/** Slug rule mirrored from docker.ts, for predicting a project's work directory. */
export function projectSlug(name: string): string {
	return (
		name
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, "-")
			.slice(0, 40) || "project"
	);
}
