import { describe, it, expect } from "vitest";
import {
  attachmentDirName,
  resolveAttachmentDir,
  rewriteAttachmentRefs,
  fileStem,
} from "../attachment";

const PERDOC = {
  attachmentMode: "perDocument" as const,
  attachmentTemplate: "{filename}_attachment",
  assetsDir: "_attachment",
};
const SHARED = {
  attachmentMode: "shared" as const,
  attachmentTemplate: "{filename}_attachment",
  assetsDir: "_attachment",
};

describe("fileStem", () => {
  it("去扩展名", () => {
    expect(fileStem("测试.md")).toBe("测试");
    expect(fileStem("a.b.md")).toBe("a.b");
    expect(fileStem("noext")).toBe("noext");
  });
});

describe("attachmentDirName", () => {
  it("perDocument 默认模板", () => {
    expect(attachmentDirName("C:/notes/测试.md", PERDOC)).toBe("测试_attachment");
  });
  it("perDocument 自定义模板", () => {
    const s = { ...PERDOC, attachmentTemplate: "{filename}-files" };
    expect(attachmentDirName("C:/notes/note.md", s)).toBe("note-files");
  });
  it("shared 模式返回统一目录名", () => {
    expect(attachmentDirName("C:/notes/测试.md", SHARED)).toBe("_attachment");
  });
});

describe("resolveAttachmentDir", () => {
  it("返回同级完整路径", () => {
    expect(resolveAttachmentDir("C:/notes/测试.md", PERDOC)).toBe("C:/notes/测试_attachment");
  });
  it("Windows 反斜杠归一化", () => {
    expect(resolveAttachmentDir("C:\\notes\\A.md", PERDOC)).toBe("C:/notes/A_attachment");
  });
});

describe("rewriteAttachmentRefs（重命名联动）", () => {
  const mdDir = "C:/notes";
  const oldDir = "C:/notes/old_attachment";
  const newName = "new_attachment";

  it("改写指向旧目录的相对引用", () => {
    const text = "![](old_attachment/a.png)\n![](old_attachment/b.png)";
    const res = rewriteAttachmentRefs(text, mdDir, [oldDir], "old_attachment", newName);
    expect(res.count).toBe(2);
    expect(res.text).toBe("![](new_attachment/a.png)\n![](new_attachment/b.png)");
  });

  it("不改动其它文档的附件引用", () => {
    const text = "![](other_attachment/x.png)";
    const res = rewriteAttachmentRefs(text, mdDir, [oldDir], "old_attachment", newName);
    expect(res.count).toBe(0);
    expect(res.text).toBe(text);
  });

  it("不改动散文里的 attachments 字样", () => {
    const text = "参见 attachments 目录的说明";
    const res = rewriteAttachmentRefs(text, mdDir, [oldDir], "old_attachment", newName);
    expect(res.count).toBe(0);
  });

  it("不改动外部链接", () => {
    const text = "![](https://x.com/old_attachment/a.png)";
    const res = rewriteAttachmentRefs(text, mdDir, [oldDir], "old_attachment", newName);
    expect(res.count).toBe(0);
  });

  it("HTML <img> 引用同样改写", () => {
    const text = '<img src="old_attachment/a.jpg" alt="x">';
    const res = rewriteAttachmentRefs(text, mdDir, [oldDir], "old_attachment", newName);
    expect(res.count).toBe(1);
    expect(res.text).toBe('<img src="new_attachment/a.jpg" alt="x">');
  });
});
