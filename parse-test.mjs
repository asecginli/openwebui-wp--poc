function normalizeQuotes(text = "") {
  return text
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'");
}

function parseTelegramInstruction(rawText) {
  if (!rawText) return null;
  const normalized = normalizeQuotes(rawText).trim();
  const lower = normalized.toLowerCase();

  if (!lower.includes('wordpress post')) {
    return null;
  }

  const isCreate =
    lower.includes('create a wordpress post') ||
    lower.includes('create wordpress post') ||
    lower.includes('create new wordpress post');
  if (!isCreate) {
    return null;
  }

  const titleMatch = normalized.match(
    /(?:titled|title|called|named)\s*["']([^"']+)["']/
  );
  const contentMatch = normalized.match(
    /(?:content|body|text)\s*["']([^"']+)["']/
  );

  if (!titleMatch || !contentMatch) {
    return null;
  }

  const statusMatch = lower.match(/\b(draft|publish|published|private)\b/);
  let status = 'publish';
  if (statusMatch) {
    const statusToken = statusMatch[1];
    if (statusToken === 'draft') status = 'draft';
    else if (statusToken === 'private') status = 'private';
  }

  const title = titleMatch[1].trim();
  const content = contentMatch[1].trim();

  if (!title || !content) {
    return null;
  }

  return {
    action: 'create_post',
    args: { title, content, status }
  };
}

console.log(parseTelegramInstruction("Create a WordPress post titled ‘Foo’ with content ‘Bar’."));
console.log(parseTelegramInstruction("Create a WordPress post titled \"Weekend Update\" with content \"We published a new release.\""));
