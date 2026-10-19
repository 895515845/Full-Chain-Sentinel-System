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
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ChevronUp,
	Container,
	Download,
	Eye,
	FileCode,
	FileText,
	Folder,
	FolderOpen,
	FolderUp,
	GitBranch,
	Image as ImageGlyph,
	Info,
	KeyRound,
	LayoutGrid,
	LogOut,
	type LucideProps,
	MessageSquare,
	Minimize2,
	Network,
	Package,
	Pencil,
	Plug,
	Radar,
	RefreshCw,
	Settings,
	Shield,
	ShieldCheck,
	SlidersHorizontal,
	Smartphone,
	Target,
	Trash,
	X,
	XCircle,
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

/** Asset mapping: query FOFA / Quake / Hunter for exposed assets. */
export function AssetIcon(props: IconProps) {
	return <Radar size={NAV_SIZE} strokeWidth={NAV_STROKE} {...props} />;
}

/** Custom MCP servers: plug the console into external tool servers. */
export function McpIcon(props: IconProps) {
	return <Plug size={NAV_SIZE} strokeWidth={NAV_STROKE} {...props} />;
}

/** Community plugins: Docker images mounted as MCP servers. */
export function PluginIcon(props: IconProps) {
	return <Package size={NAV_SIZE} strokeWidth={NAV_STROKE} {...props} />;
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

/** Sider menu: Android devices (the Droid plugin). */
export function DroidIcon(props: IconProps) {
	return <Smartphone size={NAV_SIZE} strokeWidth={NAV_STROKE} {...props} />;
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

/** Sider menu and composer: supervision of the conversation. */
export function SupervisorIcon(props: IconProps) {
	return <Eye size={NAV_SIZE} strokeWidth={NAV_STROKE} {...props} />;
}

/**
 * The product mark: a shield with a chain link inside (source: brand/icons/01-shield-link.svg).
 *
 * Unlike the lucide icons above it is filled rather than stroked, so it takes no stroke
 * width; like them it inherits `currentColor`.
 */
export function SentinelMark({ size = 20, className }: { size?: number; className?: string }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 64 64"
			className={className}
			aria-hidden="true"
			focusable="false"
		>
			<path
				fill="currentColor"
				fillRule="evenodd"
				d="M32 2.5 57.5 12v19.2c0 15.1-11.4 26.6-25.5 31.6C17.9 57.8 6.5 46.3 6.5 31.2V12L32 2.5Zm0 6.6L12.5 16.4v14.8c0 11.9 8.8 21.2 19.5 25.6 10.7-4.4 19.5-13.7 19.5-25.6V16.4L32 9.1Z"
			/>
			<path
				fill="currentColor"
				fillRule="evenodd"
				d="M27 20h10a8 8 0 0 1 8 8v8a8 8 0 0 1-8 8H27a8 8 0 0 1-8-8v-8a8 8 0 0 1 8-8Zm2 7h6a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3h-6a3 3 0 0 1-3-3v-4a3 3 0 0 1 3-3Z"
			/>
		</svg>
	);
}
