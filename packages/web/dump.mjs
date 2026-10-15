import { writeFileSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { branchTranscript } from "./dist/transcript.js";

const manager = SessionManager.open(process.argv[2], undefined, process.cwd());
const branch = manager.getBranch();
console.log("branch entries:", branch.length);
const messages = branchTranscript(branch);
writeFileSync("/tmp/messages.json", JSON.stringify(messages));
console.log(
	"dumped",
	messages.length,
	":",
	messages.map((m) => m.role + (m.customType ? ":" + m.customType : "")).join(", "),
);
