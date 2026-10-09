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
	Bot,
	ChevronDown,
	ChevronRight,
	ChevronUp,
	FileText,
	Folder,
	FolderOpen,
	FolderUp,
	GitBranch,
	History,
	Image as ImageGlyph,
	MessageSquare,
	Minimize2,
	Pencil,
	Settings,
	Trash,
	X,
	type LucideProps,
} from "lucide-react";

/** Matches the 12-13px label text the icons sit next to. */
const SIZE = 14;
/** Lighter than lucide's default 2, so icons read as labels rather than buttons. */
const STROKE = 1.75;
/** The sidebar's primary tabs are larger than inline icons. */
const NAV_SIZE = 18;
const NAV_STROKE = 1.8;

type IconProps = LucideProps;

/** Branch / fork: the branch drawer and a fork point in the tree. */
export function BranchIcon(props: IconProps) {
	return <GitBranch size={SIZE} strokeWidth={STROKE} {...props} />;
}

/** Compact context: squeeze the conversation down to a summary. */
export function CompactIcon(props: IconProps) {
	return <Minimize2 size={SIZE} strokeWidth={STROKE} {...props} />;
}

/** Container work directory: the file tab of the side panel. */
export function FilesIcon(props: IconProps) {
	return <FolderOpen size={SIZE} strokeWidth={STROKE} {...props} />;
}

/** Sub-agent: the sub-agent tab of the side panel. */
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

/** Collapsed dropdown in the project picker. */
export function CaretUpIcon(props: IconProps) {
	return <ChevronUp size={SIZE} strokeWidth={STROKE} {...props} />;
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

/** Sidebar tab: the conversation. */
export function ChatIcon(props: IconProps) {
	return <MessageSquare size={NAV_SIZE} strokeWidth={NAV_STROKE} {...props} />;
}

/** Sidebar tab: session history. */
export function HistoryIcon(props: IconProps) {
	return <History size={NAV_SIZE} strokeWidth={NAV_STROKE} {...props} />;
}

/** Sidebar tab: model settings. */
export function SettingsIcon(props: IconProps) {
	return <Settings size={NAV_SIZE} strokeWidth={NAV_STROKE} {...props} />;
}

/** Rename an entry. */
export function RenameIcon(props: IconProps) {
	return <Pencil size={SIZE} strokeWidth={STROKE} {...props} />;
}

/** Delete an entry. */
export function DeleteIcon(props: IconProps) {
	return <Trash size={SIZE} strokeWidth={STROKE} {...props} />;
}
