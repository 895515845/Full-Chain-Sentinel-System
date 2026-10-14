/**
 * The console's icon set.
 *
 * Icons are re-exported with a fixed size and stroke weight so the whole UI
 * stays visually consistent, and so there is one place to tune them. Import
 * icons from here rather than from lucide-react directly; add new ones here.
 * Every wrapper still accepts lucide's props, so a call site can override the
 * size when a control needs a smaller glyph.
 */

import {
	Bell,
	Bot,
	Bug,
	Check,
	KeyRound,
	LogOut,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ChevronUp,
	Container,
	Download,
	FileText,
	Folder,
	FolderOpen,
	FolderUp,
	GitBranch,
	Image as ImageGlyph,
	Info,
	LayoutGrid,
	MessageSquare,
	Minimize2,
	Network,
	Pencil,
	Plug,
	RefreshCw,
	Settings,
	Shield,
	ShieldCheck,
	FileCode,
	SlidersHorizontal,
	Target,
	Trash,
	X,
	XCircle,
	type LucideProps,
} from "lucide-react";

/** Matches the 12-13px label text the icons sit next to. */
const SIZE = 14;
/** Lighter than lucide's default 2, so icons read as labels rather than buttons. */
const STROKE = 1.75;
/** The sider's menu rows are larger than inline icons. */
const NAV_SIZE = 16;
const NAV_STROKE = 1.8;

type IconProps = LucideProps;

/** Notification: whether a finished run reports to DingTalk. */
export function BellIcon(props: IconProps) {
	return <Bell size={SIZE} strokeWidth={STROKE} {...props} />;
}

/** Branch / fork: the branch drawer and a fork point in the tree. */
export function BranchIcon(props: IconProps) {
	return <GitBranch size={SIZE} strokeWidth={STROKE} {...props} />;
}

/** Persistent goal: the objective the agent keeps working on by itself. */
export function TargetIcon(props: IconProps) {
	return <Target size={SIZE} strokeWidth={STROKE} {...props} />;
}

/** Compact context: squeeze the conversation down to a summary. */
export function CompactIcon(props: IconProps) {
	return <Minimize2 size={SIZE} strokeWidth={STROKE} {...props} />;
}

/** Container work directory: the files page. */
export function FilesIcon(props: IconProps) {
	return <FolderOpen size={SIZE} strokeWidth={STROKE} {...props} />;
}

/** Sub-agent: the sub-agent runs page. */
export function SubagentIcon(props: IconProps) {
	return <Bot size={SIZE} strokeWidth={STROKE} {...props} />;
}

/** Image attachment. */
export function ImageIcon(props: IconProps) {
	return <ImageGlyph size={SIZE} strokeWidth={STROKE} {...props} />;
}

/** Close / dismiss a panel or dialog. */
export function CloseIcon(props: IconProps) {
	return <X size={SIZE} strokeWidth={STROKE} {...props} />;
}

/** Collapsed disclosure triangle. */
export function CaretRightIcon(props: IconProps) {
	return <ChevronRight size={SIZE} strokeWidth={STROKE} {...props} />;
}

/** Expanded disclosure triangle. */
export function CaretDownIcon(props: IconProps) {
	return <ChevronDown size={SIZE} strokeWidth={STROKE} {...props} />;
}

/** Collapsed dropdown in the project selector. */
export function CaretUpIcon(props: IconProps) {
	return <ChevronUp size={SIZE} strokeWidth={STROKE} {...props} />;
}

/** Collapse the sider. */
export function CollapseIcon(props: IconProps) {
	return <ChevronLeft size={NAV_SIZE} strokeWidth={NAV_STROKE} {...props} />;
}

/** Expand the sider. */
export function ExpandIcon(props: IconProps) {
	return <ChevronRight size={NAV_SIZE} strokeWidth={NAV_STROKE} {...props} />;
}

/** Parent directory in the file panel. */
export function ParentDirIcon(props: IconProps) {
	return <FolderUp size={SIZE} strokeWidth={STROKE} {...props} />;
}

/** Directory entry in a listing. */
export function DirIcon(props: IconProps) {
	return <Folder size={SIZE} strokeWidth={STROKE} {...props} />;
}

/** File entry in a listing. */
export function FileIcon(props: IconProps) {
	return <FileText size={SIZE} strokeWidth={STROKE} {...props} />;
}

/** Sider menu: the conversation. */
export function ChatIcon(props: IconProps) {
	return <MessageSquare size={NAV_SIZE} strokeWidth={NAV_STROKE} {...props} />;
}

/** Sider menu: projects. */
export function ProjectsIcon(props: IconProps) {
	return <LayoutGrid size={NAV_SIZE} strokeWidth={NAV_STROKE} {...props} />;
}

/** Sider menu: settings. */
export function SettingsIcon(props: IconProps) {
	return <Settings size={NAV_SIZE} strokeWidth={NAV_STROKE} {...props} />;
}

/** Sider menu: model endpoint settings. */
export function ModelIcon(props: IconProps) {
	return <SlidersHorizontal size={NAV_SIZE} strokeWidth={NAV_STROKE} {...props} />;
}

/** Sider menu: notification settings. */
export function NotifyIcon(props: IconProps) {
	return <Plug size={NAV_SIZE} strokeWidth={NAV_STROKE} {...props} />;
}

/** Sider menu: about this console. */
export function AboutIcon(props: IconProps) {
	return <Info size={NAV_SIZE} strokeWidth={NAV_STROKE} {...props} />;
}

/** Refresh the page behind a tab, or the whole console. */
export function RefreshIcon(props: IconProps) {
	return <RefreshCw size={SIZE} strokeWidth={STROKE} {...props} />;
}

/** Close every tab but the affixed one. */
export function CloseOthersIcon(props: IconProps) {
	return <XCircle size={SIZE} strokeWidth={STROKE} {...props} />;
}

/** Tool permissions for the main agent and its sub-agents. */
export function ShieldIcon(props: IconProps) {
	return <Shield size={NAV_SIZE} strokeWidth={NAV_STROKE} {...props} />;
}

/** Environment: the Docker runtime the console depends on. */
export function EnvironmentIcon(props: IconProps) {
	return <Container size={NAV_SIZE} strokeWidth={NAV_STROKE} {...props} />;
}

/** Rename an entry. */
export function RenameIcon(props: IconProps) {
	return <Pencil size={SIZE} strokeWidth={STROKE} {...props} />;
}

/** Delete an entry. */
export function DeleteIcon(props: IconProps) {
	return <Trash size={SIZE} strokeWidth={STROKE} {...props} />;
}

/** Sider menu: the vulnerability hub. */
export function VulnIcon(props: IconProps) {
	return <Bug size={NAV_SIZE} strokeWidth={NAV_STROKE} {...props} />;
}

/** Sider menu: the POC library. */
export function PocIcon(props: IconProps) {
	return <FileCode size={NAV_SIZE} strokeWidth={NAV_STROKE} {...props} />;
}

/** Sider menu and composer: business modeling — the API model of a target. */
export function ApiModelIcon(props: IconProps) {
	return <Network size={NAV_SIZE} strokeWidth={NAV_STROKE} {...props} />;
}

/** Sider menu: console security settings. */
export function LockIcon(props: IconProps) {
	return <KeyRound size={NAV_SIZE} strokeWidth={NAV_STROKE} {...props} />;
}

/** Log out of the console. */
export function LogoutIcon(props: IconProps) {
	return <LogOut size={SIZE} strokeWidth={STROKE} {...props} />;
}

/** Export the hub as a Markdown report. */
export function DownloadIcon(props: IconProps) {
	return <Download size={SIZE} strokeWidth={STROKE} {...props} />;
}

/** Confirm a finding. */
export function CheckIcon(props: IconProps) {
	return <Check size={SIZE} strokeWidth={STROKE} {...props} />;
}

/** Sider menu: the gatekeeper audit log of AI 审批 judgments. */
export function GateIcon(props: IconProps) {
	return <ShieldCheck size={NAV_SIZE} strokeWidth={NAV_STROKE} {...props} />;
}
