"use client";

import { appPrompt } from "@/store/dialogStore";
import { useT } from "@/store/prefStore";
import { useEffect, useImperativeHandle, forwardRef } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import TextAlign from "@tiptap/extension-text-align";
import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough,
  Heading1, Heading2, Heading3, List, ListOrdered, Quote,
  Link as LinkIcon, Image as ImageIcon, AlignLeft, AlignCenter,
  AlignRight, Minus, Undo2, Redo2, RemoveFormatting,
} from "lucide-react";

export type RichEditorHandle = {
  /** Insert raw text/HTML at the current cursor position. */
  insert: (content: string) => void;
};

type Props = { value: string; onChange: (html: string) => void };

function ToolbarBtn({
  onClick,
  active,
  title,
  children,
  disabled,
}: {
  onClick: () => void;
  active?: boolean;
  title: string;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`grid h-8 w-8 place-items-center rounded-md border text-slate-600 transition disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? "border-brand-600 bg-brand-50 text-brand-600"
          : "border-transparent hover:bg-slate-100"
      }`}
    >
      {children}
    </button>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const t = useT();
  const sep = <span className="mx-1 h-5 w-px bg-slate-200" />;

  async function setLink() {
    const prev = editor.getAttributes("link").href as string | undefined;
    const url = await appPrompt(t("Διεύθυνση συνδέσμου (URL):", "Link address (URL):"), { title: t("Σύνδεσμος", "Link"), defaultValue: prev ?? "", placeholder: "https://…" });
    if (url === null) return; // cancelled
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  }

  async function addImage() {
    const url = await appPrompt(t("Διεύθυνση εικόνας (URL):", "Image address (URL):"), { title: t("Εικόνα", "Image"), placeholder: "https://…" });
    if (url) editor.chain().focus().setImage({ src: url }).run();
  }

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-slate-200 bg-slate-50 px-2 py-1.5">
      <ToolbarBtn title={t("Έντονα", "Bold")} active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}><Bold className="h-4 w-4" /></ToolbarBtn>
      <ToolbarBtn title={t("Πλάγια", "Italic")} active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic className="h-4 w-4" /></ToolbarBtn>
      <ToolbarBtn title={t("Υπογράμμιση", "Underline")} active={editor.isActive("underline")} onClick={() => editor.chain().focus().toggleUnderline().run()}><UnderlineIcon className="h-4 w-4" /></ToolbarBtn>
      <ToolbarBtn title={t("Διακριτή διαγραφή", "Strikethrough")} active={editor.isActive("strike")} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough className="h-4 w-4" /></ToolbarBtn>
      {sep}
      <ToolbarBtn title={t("Επικεφαλίδα 1", "Heading 1")} active={editor.isActive("heading", { level: 1 })} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}><Heading1 className="h-4 w-4" /></ToolbarBtn>
      <ToolbarBtn title={t("Επικεφαλίδα 2", "Heading 2")} active={editor.isActive("heading", { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 className="h-4 w-4" /></ToolbarBtn>
      <ToolbarBtn title={t("Επικεφαλίδα 3", "Heading 3")} active={editor.isActive("heading", { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}><Heading3 className="h-4 w-4" /></ToolbarBtn>
      {sep}
      <ToolbarBtn title={t("Λίστα με κουκκίδες", "Bullet list")} active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()}><List className="h-4 w-4" /></ToolbarBtn>
      <ToolbarBtn title={t("Αριθμημένη λίστα", "Numbered list")} active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered className="h-4 w-4" /></ToolbarBtn>
      <ToolbarBtn title={t("Παράθεση", "Quote")} active={editor.isActive("blockquote")} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote className="h-4 w-4" /></ToolbarBtn>
      {sep}
      <ToolbarBtn title={t("Σύνδεσμος", "Link")} active={editor.isActive("link")} onClick={setLink}><LinkIcon className="h-4 w-4" /></ToolbarBtn>
      <ToolbarBtn title={t("Εικόνα", "Image")} onClick={addImage}><ImageIcon className="h-4 w-4" /></ToolbarBtn>
      {sep}
      <ToolbarBtn title={t("Στοίχιση αριστερά", "Align left")} active={editor.isActive({ textAlign: "left" })} onClick={() => editor.chain().focus().setTextAlign("left").run()}><AlignLeft className="h-4 w-4" /></ToolbarBtn>
      <ToolbarBtn title={t("Στοίχιση στο κέντρο", "Align center")} active={editor.isActive({ textAlign: "center" })} onClick={() => editor.chain().focus().setTextAlign("center").run()}><AlignCenter className="h-4 w-4" /></ToolbarBtn>
      <ToolbarBtn title={t("Στοίχιση δεξιά", "Align right")} active={editor.isActive({ textAlign: "right" })} onClick={() => editor.chain().focus().setTextAlign("right").run()}><AlignRight className="h-4 w-4" /></ToolbarBtn>
      {sep}
      <ToolbarBtn title={t("Οριζόντια γραμμή", "Horizontal rule")} onClick={() => editor.chain().focus().setHorizontalRule().run()}><Minus className="h-4 w-4" /></ToolbarBtn>
      <ToolbarBtn title={t("Αναίρεση", "Undo")} disabled={!editor.can().undo()} onClick={() => editor.chain().focus().undo().run()}><Undo2 className="h-4 w-4" /></ToolbarBtn>
      <ToolbarBtn title={t("Επανάληψη", "Redo")} disabled={!editor.can().redo()} onClick={() => editor.chain().focus().redo().run()}><Redo2 className="h-4 w-4" /></ToolbarBtn>
      <ToolbarBtn title={t("Καθαρισμός μορφοποίησης", "Clear formatting")} onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}><RemoveFormatting className="h-4 w-4" /></ToolbarBtn>
    </div>
  );
}

const RichEditor = forwardRef<RichEditorHandle, Props>(function RichEditor(
  { value, onChange },
  ref,
) {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit,
      Underline,
      Link.configure({ openOnClick: false }),
      Image,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
    ],
    content: value,
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
    editorProps: {
      attributes: {
        class: "focus:outline-none",
      },
    },
  });

  useImperativeHandle(
    ref,
    () => ({
      insert: (content: string) => {
        editor?.chain().focus().insertContent(content).run();
      },
    }),
    [editor],
  );

  // Keep editor content in sync when `value` is replaced externally
  // (e.g. template presets), without clobbering normal typing.
  useEffect(() => {
    if (!editor) return;
    if (value !== editor.getHTML()) {
      editor.commands.setContent(value, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, editor]);

  return (
    <div className="overflow-hidden rounded-lg border border-slate-300">
      {editor && <Toolbar editor={editor} />}
      <div
        className="min-h-[360px] bg-white p-5 text-[15px] leading-relaxed text-slate-800
          [&_.ProseMirror]:min-h-[320px] [&_.ProseMirror]:outline-none
          [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:text-slate-900
          [&_h2]:mb-2 [&_h2]:text-xl [&_h2]:font-bold [&_h2]:text-slate-900
          [&_h3]:mb-2 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:text-slate-900
          [&_p]:mb-3
          [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-5
          [&_ol]:mb-3 [&_ol]:list-decimal [&_ol]:pl-5
          [&_li]:mb-1
          [&_a]:text-brand-600 [&_a]:underline
          [&_blockquote]:my-3 [&_blockquote]:border-l-4 [&_blockquote]:border-slate-300 [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:text-slate-600
          [&_hr]:my-4 [&_hr]:border-slate-200
          [&_img]:my-3 [&_img]:max-w-full [&_img]:rounded"
        onClick={() => editor?.chain().focus().run()}
      >
        <EditorContent editor={editor} />
      </div>
    </div>
  );
});

export default RichEditor;
