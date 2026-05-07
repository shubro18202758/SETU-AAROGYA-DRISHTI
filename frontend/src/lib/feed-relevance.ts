const QUERY_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "by", "for", "from", "how", "in", "into", "is", "it", "new", "news",
  "of", "on", "or", "the", "to", "with", "about", "after", "before", "latest", "update", "updates", "watch",
]);

export interface FeedRelevance {
  score: number;
  matchedTerms: string[];
  requiredTerms: string[];
  exactPhrase: boolean;
  relevant: boolean;
}

export interface RelevanceInput {
  title: string;
  url: string | null;
  author: string | null;
  publishedAt?: string | null;
  tags: string[];
}

export function rankFeedItems<T extends RelevanceInput>(items: T[], query: string, limit: number): Array<T & { relevance: FeedRelevance }> {
  return items
    .map((item) => ({ ...item, relevance: scoreFeedItem(item, query) }))
    .filter((item) => item.relevance.relevant)
    .sort((left, right) => {
      if (right.relevance.score !== left.relevance.score) {
        return right.relevance.score - left.relevance.score;
      }
      return freshnessScore(right) - freshnessScore(left);
    })
    .slice(0, limit);
}

export function scoreFeedItem(item: RelevanceInput, query: string): FeedRelevance {
  const requiredTerms = queryTerms(query);
  if (requiredTerms.length === 0) {
    return { score: 1, matchedTerms: [], requiredTerms, exactPhrase: false, relevant: true };
  }

  const normalizedTitle = normalizeText(item.title);
  const normalizedUrl = normalizeText(item.url ?? "");
  const normalizedTags = normalizeText(item.tags.join(" "));
  const normalizedHaystack = `${normalizedTitle} ${normalizedUrl} ${normalizedTags}`;
  const normalizedQuery = normalizeText(query.replace(/\b(?:AND|OR|NOT)\b/gi, " "));
  const hasOrOperator = /\bOR\b/i.test(query) || query.includes("|");
  const exactPhrase = normalizedQuery.length > 3 && normalizedTitle.includes(normalizedQuery);
  const matchedTerms = requiredTerms.filter((term) => normalizedHaystack.includes(term));
  const titleMatches = requiredTerms.filter((term) => normalizedTitle.includes(term)).length;
  const tagMatches = requiredTerms.filter((term) => normalizedTags.includes(term)).length;
  const enoughCoverage = hasOrOperator
    ? matchedTerms.length > 0
    : matchedTerms.length >= Math.max(1, Math.ceil(requiredTerms.length * 0.78));
  const relevant = exactPhrase || enoughCoverage;
  const score =
    (exactPhrase ? 12 : 0) +
    titleMatches * 5 +
    tagMatches * 3 +
    matchedTerms.length * 2 +
    (matchedTerms.length === requiredTerms.length ? 4 : 0) +
    Math.min(4, Math.round(Math.log10(Math.max(1, normalizedUrl.length))));

  return { score, matchedTerms, requiredTerms, exactPhrase, relevant };
}

export function queryTerms(query: string): string[] {
  const normalized = normalizeText(query)
    .replace(/\b(?:and|or|not)\b/g, " ")
    .replace(/[|()+]/g, " ");
  const terms = normalized
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 2 && !QUERY_STOPWORDS.has(term));
  return [...new Set(terms)];
}

export function relevanceNotice(source: string, query: string, resultCount: number): string | null {
  const terms = queryTerms(query);
  if (terms.length === 0 || resultCount > 0) {
    return null;
  }
  return `${source} returned no high-relevance items for "${query}" after local term coverage checks.`;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/https?:\/\//g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function freshnessScore(item: { publishedAt?: string | null }): number {
  if (typeof item.publishedAt !== "string") {
    return 0;
  }
  const timestamp = new Date(item.publishedAt).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}