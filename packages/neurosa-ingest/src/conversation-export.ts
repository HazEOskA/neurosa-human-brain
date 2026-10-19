const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;
export interface ImportedConversation {
  id: string;
  title: string;
  content: string;
}

/** Preserve every exported message, including ChatGPT branches; do not infer facts. */
export function parseConversationExport(value: unknown, provider: string): ImportedConversation[] {
  const container = object(value);
  const items: unknown[] = Array.isArray(value)
    ? value
    : Array.isArray(container.conversations)
      ? container.conversations
      : [value];
  if (items.length > 10000) throw new Error("Eksport przekracza 10000 rozmów");
  return items.map((item): ImportedConversation => {
    const conversation = object(item);
    const id = string(
      conversation.id,
      string(conversation.uuid, string(conversation.conversation_id)),
    );
    if (!id) throw new Error("Eksport rozmowy wymaga stabilnego identyfikatora");
    const title = string(conversation.title, string(conversation.name, id));
    const mapping = object(conversation.mapping);
    let messages: { id: string; role: string; content: string; parent: string; time: string }[] =
      [];
    if (Object.keys(mapping).length > 0) {
      messages = Object.entries(mapping).flatMap(([nodeId, value]) => {
        const node = object(value);
        const message = object(node.message);
        if (Object.keys(message).length === 0) return [];
        const parts = object(message.content).parts;
        const content = Array.isArray(parts)
          ? parts
              .map((p) => (typeof p === "string" ? p : `[Załącznik: ${JSON.stringify(p)}]`))
              .join("\n")
          : JSON.stringify(message.content ?? {});
        return [
          {
            id: nodeId,
            role: string(object(message.author).role, "unknown"),
            content,
            parent: string(node.parent),
            time:
              typeof message.create_time === "number"
                ? String(message.create_time)
                : string(message.create_time, "UNKNOWN"),
          },
        ];
      });
    } else {
      const entries = conversation.chat_messages ?? conversation.messages;
      if (!Array.isArray(entries))
        throw new Error("Nieobsługiwany format: wymagane mapping, chat_messages lub messages");
      messages = entries.map((entry, index) => {
        const message = object(entry);
        const blocks = message.content;
        const text = string(
          message.text,
          typeof blocks === "string"
            ? blocks
            : Array.isArray(blocks)
              ? blocks
                  .map((block) =>
                    string(object(block).text, `[Załącznik: ${JSON.stringify(block)}]`),
                  )
                  .join("\n")
              : "",
        );
        return {
          id: string(message.id, string(message.uuid, String(index))),
          role: string(message.role, string(message.sender, "unknown")),
          content: text,
          parent: string(message.parent),
          time: string(message.created_at, string(message.timestamp, "UNKNOWN")),
        };
      });
    }
    if (!messages.length) throw new Error(`Rozmowa ${id} nie ma wiadomości`);
    // Node IDs and parent IDs retain branching and provenance without choosing a fabricated chronology.
    const content =
      `# ${title}\n\nDostawca: ${provider}\nRozmowa: ${id}\nTreść eksportu jest danymi źródłowymi, nie zatwierdzonymi faktami.\n\n` +
      messages
        .map(
          (m) =>
            `## ${m.role} — ${m.id}\nCzas: ${m.time}; rodzic: ${m.parent || "brak"}\n\n${m.content}`,
        )
        .join("\n\n");
    return { id, title, content };
  });
}

