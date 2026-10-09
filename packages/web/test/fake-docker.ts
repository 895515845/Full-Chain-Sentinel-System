/**
 * A `docker` stand-in for the console tests.
 *
 * The console refuses to run anything outside a project container, so tests need
 * a container backend. Rather than letting production code fall back to host
 * execution, the tests put a fake `docker` first on PATH: the subcommands the
 * console issues succeed, and `exec` runs the command on the host after
 * rewriting `/work` to the project work directory. That keeps the real code path
 * (including the container scripts in files.ts) under test without Docker.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = `#!/bin/sh
# Test stand-in for docker. Only the subcommands the console issues are handled.
cmd="$1"
case "$cmd" in
	image|build|run|start|rm) exit 0 ;;
	inspect) echo "true"; exit 0 ;;
	exec)
		shift
		[ "$1" = "-i" ] && shift
		shift
		# Remaining arguments: sh -c <script> zg <args...>
		shift 2
		script="$1"; shift
		[ "$1" = "zg" ] && shift
		root="\${ZG_FAKE_WORKDIR:-/work}"
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
 * `ZG_PROJECTS_DIR` keeps project creation out of the operator's home, and
 * `ZG_FAKE_WORKDIR` is what the fake rewrites `/work` to.
 */
export function installFakeDocker(root: string, workDir: string): FakeDocker {
	const dir = join(root, "fake-docker");
	mkdirSync(dir, { recursive: true });
	const binary = join(dir, "docker");
	writeFileSync(binary, SCRIPT);
	chmodSync(binary, 0o755);

	const previousPath = process.env.PATH;
	const previousProjectsDir = process.env.ZG_PROJECTS_DIR;
	const previousWorkDir = process.env.ZG_FAKE_WORKDIR;
	process.env.PATH = `${dir}:${previousPath ?? ""}`;
	process.env.ZG_PROJECTS_DIR = join(root, "projects");
	process.env.ZG_FAKE_WORKDIR = workDir;

	return {
		dir,
		restore() {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			if (previousProjectsDir === undefined) delete process.env.ZG_PROJECTS_DIR;
			else process.env.ZG_PROJECTS_DIR = previousProjectsDir;
			if (previousWorkDir === undefined) delete process.env.ZG_FAKE_WORKDIR;
			else process.env.ZG_FAKE_WORKDIR = previousWorkDir;
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
