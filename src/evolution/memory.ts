import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createLogger } from "../logger";

const log = createLogger("evolution:memory");

const MEMORY_FILES = ["SOUL", "USER", "WORLD"] as const;
type MemoryFile = (typeof MEMORY_FILES)[number];

export class MemoryStore {
  private basePath: string;

  constructor(basePath?: string) {
    this.basePath =
      basePath ?? resolve(process.cwd(), "user-space", "memory");
    if (!existsSync(this.basePath)) {
      mkdirSync(this.basePath, { recursive: true });
    }
  }

  private filePath(file: MemoryFile): string {
    return resolve(this.basePath, `${file}.md`);
  }

  async read(file: MemoryFile): Promise<string> {
    const path = this.filePath(file);
    if (!existsSync(path)) return "";
    return Bun.file(path).text();
  }

  async readAll(): Promise<{ soul: string; user: string; world: string }> {
    const [soul, user, world] = await Promise.all([
      this.read("SOUL"),
      this.read("USER"),
      this.read("WORLD"),
    ]);
    return { soul, user, world };
  }

  /**
   * Replace a markdown section (## heading) with new content.
   * If the section doesn't exist, appends it at the end.
   */
  async updateSection(
    file: MemoryFile,
    section: string,
    content: string,
  ): Promise<void> {
    if (!MEMORY_FILES.includes(file)) {
      throw new Error(`Invalid memory file: ${file}`);
    }

    const path = this.filePath(file);
    let text = existsSync(path) ? await Bun.file(path).text() : "";

    const sectionHeader = section.startsWith("#") ? section : `## ${section}`;
    const headerLevel = sectionHeader.match(/^#+/)?.[0].length ?? 2;
    const escapedHeader = sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // Match from the section header to the next header of same or higher level, or EOF
    const pattern = new RegExp(
      `(${escapedHeader}[^\n]*\n)([\\s\\S]*?)(?=\n#{1,${headerLevel}} |$)`,
    );

    const newSection = `${sectionHeader}\n\n${content.trim()}\n`;

    if (pattern.test(text)) {
      text = text.replace(pattern, newSection);
    } else {
      text = text.trimEnd() + "\n\n" + newSection;
    }

    await Bun.write(path, text);
    log.info("Memory updated", { file, section });
  }

  /**
   * Append a timestamped entry to a section.
   */
  async appendEntry(
    file: MemoryFile,
    section: string,
    entry: string,
  ): Promise<void> {
    const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
    const line = `- [${timestamp}] ${entry}`;

    const path = this.filePath(file);
    let text = existsSync(path) ? await Bun.file(path).text() : "";

    const sectionHeader = section.startsWith("#") ? section : `## ${section}`;

    if (text.includes(sectionHeader)) {
      // Find the section and append after the last non-empty line in it
      const idx = text.indexOf(sectionHeader);
      const afterHeader = idx + sectionHeader.length;
      const rest = text.slice(afterHeader);

      // Find the next section or end of file
      const nextSection = rest.search(/\n## /);
      const insertAt =
        nextSection === -1
          ? text.length
          : afterHeader + nextSection;

      text =
        text.slice(0, insertAt).trimEnd() +
        "\n" +
        line +
        "\n" +
        text.slice(insertAt);
    } else {
      text = text.trimEnd() + `\n\n${sectionHeader}\n\n${line}\n`;
    }

    await Bun.write(path, text);
  }
}

let _store: MemoryStore | null = null;

export function getMemoryStore(): MemoryStore {
  if (!_store) _store = new MemoryStore();
  return _store;
}
