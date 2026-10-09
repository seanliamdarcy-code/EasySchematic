import { SIGNAL_LABELS } from "./types";
import type { DeviceTemplate } from "./types";

const WORD_BOUNDARY = /[\s(/_.-]/;

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

function queryWords(query: string): string[] {
  return normalizeText(query).split(/\s+/).filter(Boolean);
}

function fieldWords(value: string): string[] {
  return normalizeText(value).split(/\s+/).filter(Boolean);
}

function includesAtWordBoundary(value: string, word: string): boolean {
  const idx = value.indexOf(word);
  return idx >= 0 && (idx === 0 || WORD_BOUNDARY.test(value[idx - 1]));
}

function scoreTextField(value: string, word: string, scores: { exact: number; prefix: number; contains?: number }): number {
  if (!value) return 0;

  const normalized = normalizeText(value);
  const words = fieldWords(normalized);

  if (words.includes(word)) return scores.exact;
  if (word.length >= 2 && words.some((candidate) => candidate.startsWith(word))) return scores.prefix;

  // Avoid turning short queries into "every word containing this letter" searches.
  if (word.length >= 3 && scores.contains && includesAtWordBoundary(normalized, word)) {
    return scores.contains;
  }

  return 0;
}

/** Score how well a template matches a search query. 0 = no match. Higher = better. */
export function scoreTemplate(template: DeviceTemplate, query: string): number {
  const words = queryWords(query);
  if (words.length === 0) return 0;

  const phrase = words.join(" ");
  const label = normalizeText(template.label);
  const shortName = normalizeText(template.shortName ?? "");
  const deviceType = normalizeText(template.deviceType);
  const manufacturer = normalizeText(template.manufacturer ?? "");
  const modelNumber = normalizeText(template.modelNumber ?? "");
  const searchTerms = template.searchTerms?.map(normalizeText) ?? [];
  const signalLabels = [...new Set(template.ports.map((p) => normalizeText(SIGNAL_LABELS[p.signalType] ?? p.signalType)))];
  const signalTypes = [...new Set(template.ports.map((p) => normalizeText(p.signalType)))];
  const portLabels = template.ports.map((p) => normalizeText(p.label));

  // Exact phrase hits should outrank token-by-token coincidences.
  if (phrase.length >= 2) {
    if (label === phrase || shortName === phrase) return 260;
    if (includesAtWordBoundary(label, phrase) || (shortName && includesAtWordBoundary(shortName, phrase))) return 220;
    if (searchTerms.some((t) => t === phrase || includesAtWordBoundary(t, phrase))) return 180;
    if (modelNumber === phrase || includesAtWordBoundary(modelNumber, phrase)) return 150;

    // For single-word queries of 3+ letters, require an actual field hit on the full word.
    // This prevents a shorter in-flight prefix such as "bo" from keeping "bodypack" results
    // visible after the user has already typed "bose".
    if (words.length === 1 && phrase.length >= 3) {
      const fullWordMatches =
        scoreTextField(label, phrase, { exact: 1, prefix: 1, contains: 1 }) > 0
        || scoreTextField(shortName, phrase, { exact: 1, prefix: 1, contains: 1 }) > 0
        || scoreTextField(deviceType, phrase, { exact: 1, prefix: 1 }) > 0
        || searchTerms.some((t) => scoreTextField(t, phrase, { exact: 1, prefix: 1, contains: 1 }) > 0)
        || scoreTextField(manufacturer, phrase, { exact: 1, prefix: 1, contains: 1 }) > 0
        || scoreTextField(modelNumber, phrase, { exact: 1, prefix: 1, contains: 1 }) > 0
        || signalLabels.some((s) => scoreTextField(s, phrase, { exact: 1, prefix: 1 }) > 0)
        || signalTypes.some((s) => scoreTextField(s, phrase, { exact: 1, prefix: 1 }) > 0)
        || portLabels.some((p) => scoreTextField(p, phrase, { exact: 1, prefix: 1 }) > 0);

      if (!fullWordMatches) return 0;
    }
  }

  // Score each word, then combine
  let totalScore = 0;
  let wordsMatched = 0;

  for (const word of words) {
    let bestWordScore = 0;

    // Label match (highest value — this is the device's name)
    bestWordScore = Math.max(bestWordScore, scoreTextField(label, word, { exact: 110, prefix: 100, contains: 80 }));

    // Short name match — same scoring as full label so curated short names are findable
    bestWordScore = Math.max(bestWordScore, scoreTextField(shortName, word, { exact: 110, prefix: 100, contains: 80 }));

    // Device type match (e.g. "switch", "camera")
    bestWordScore = Math.max(bestWordScore, scoreTextField(deviceType, word, { exact: 75, prefix: 70 }));

    // Search terms (curated aliases)
    if (searchTerms.some((t) => scoreTextField(t, word, { exact: 70, prefix: 65, contains: 55 }) > 0)) {
      bestWordScore = Math.max(bestWordScore, 65);
    }

    // Manufacturer / model number
    bestWordScore = Math.max(bestWordScore, scoreTextField(manufacturer, word, { exact: 45, prefix: 40, contains: 30 }));
    bestWordScore = Math.max(bestWordScore, scoreTextField(modelNumber, word, { exact: 50, prefix: 45, contains: 35 }));

    // Signal type labels ("Ethernet", "SDI", "Dante")
    if (signalLabels.some((s) => scoreTextField(s, word, { exact: 25, prefix: 20 }) > 0)) bestWordScore = Math.max(bestWordScore, 20);
    if (signalTypes.some((s) => scoreTextField(s, word, { exact: 25, prefix: 20 }) > 0)) bestWordScore = Math.max(bestWordScore, 20);

    // Port labels ("SDI IN 1", etc.)
    if (portLabels.some((p) => scoreTextField(p, word, { exact: 15, prefix: 10 }) > 0)) bestWordScore = Math.max(bestWordScore, 10);

    if (bestWordScore > 0) wordsMatched++;
    totalScore += bestWordScore;
  }

  // All words must match something for the result to show at all
  if (wordsMatched < words.length) return 0;

  // Bonus for matching all words (multi-word queries should strongly prefer full matches)
  if (words.length > 1 && wordsMatched === words.length) {
    totalScore += 50;
  }

  return totalScore;
}

/**
 * Device-library search should be stricter than import/mapping flows.
 * For a single 3+ character word, don't surface a result purely because the
 * query appears somewhere inside a longer hidden alias phrase.
 */
export function scoreDeviceLibraryTemplate(template: DeviceTemplate, query: string): number {
  const words = queryWords(query);
  if (words.length === 0) return 0;

  const phrase = words.join(" ");
  if (words.length === 1 && phrase.length >= 3) {
    const label = normalizeText(template.label);
    const shortName = normalizeText(template.shortName ?? "");
    const manufacturer = normalizeText(template.manufacturer ?? "");
    const modelNumber = normalizeText(template.modelNumber ?? "");
    const deviceType = normalizeText(template.deviceType);
    const searchTerms = template.searchTerms?.map(normalizeText) ?? [];
    const signalLabels = [...new Set(template.ports.map((p) => normalizeText(SIGNAL_LABELS[p.signalType] ?? p.signalType)))];
    const signalTypes = [...new Set(template.ports.map((p) => normalizeText(p.signalType)))];
    const portLabels = template.ports.map((p) => normalizeText(p.label));

    const visibleFieldMatch =
      scoreTextField(label, phrase, { exact: 1, prefix: 1, contains: 1 }) > 0
      || scoreTextField(shortName, phrase, { exact: 1, prefix: 1, contains: 1 }) > 0
      || scoreTextField(manufacturer, phrase, { exact: 1, prefix: 1, contains: 1 }) > 0
      || scoreTextField(modelNumber, phrase, { exact: 1, prefix: 1, contains: 1 }) > 0
      || scoreTextField(deviceType, phrase, { exact: 1, prefix: 1 }) > 0
      || signalLabels.some((value) => scoreTextField(value, phrase, { exact: 1, prefix: 1 }) > 0)
      || signalTypes.some((value) => scoreTextField(value, phrase, { exact: 1, prefix: 1 }) > 0)
      || portLabels.some((value) => scoreTextField(value, phrase, { exact: 1, prefix: 1 }) > 0);

    const exactAliasMatch = searchTerms.some((value) => value === phrase);
    if (!visibleFieldMatch && !exactAliasMatch) return 0;
  }

  return scoreTemplate(template, query);
}
