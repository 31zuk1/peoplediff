export type Source = "CN" | "JP";

export type PairStatus =
  | "MATCHED"
  | "CN ONLY"
  | "JP ONLY"
  | "FRAMING SHIFT"
  | "BODY DIFFERENCE";

export type Article = {
  id: string;
  source: Source;
  title: string;
  translatedTitle?: string;
  url: string;
  urlDate?: string;
  publishedAt?: string;
  publishedDate?: string;
  dateMismatch?: boolean;
  discoveredFrom?: string;
  category?: string;
  body: string;
  summary: string;
  keywords: string[];
};

export type DifferenceAnalysis = {
  sameTopic?: boolean;
  matchConfidence?: number;
  bodyDifferenceScore?: number;
  framingShiftScore?: number;
  cnPoints: string[];
  jpPoints: string[];
  missingPoints: string[];
  emphasizedPoints: string[];
  toneDifference: string;
  politicalLanguage: string;
  verdict: string;
  shiftScore: number;
};

export type ArticlePair = {
  id: string;
  status: PairStatus;
  cn?: Article;
  jp?: Article;
  matchScore: number;
  analysis?: DifferenceAnalysis;
  highlights: string[];
};

export type RefreshStats = {
  cnCount: number;
  jpCount: number;
  cnDateCounts: Record<string, number>;
  jpDateCounts: Record<string, number>;
  dateMismatches: number;
  matched: number;
  cnOnly: number;
  jpOnly: number;
  framingShift: number;
  bodyDifference: number;
  coverageRatio: number;
};

export type RefreshResult = {
  generatedAt: string;
  mode: "live" | "demo" | "empty";
  model: string;
  activeDate?: string;
  archiveDates?: string[];
  dateScope?: string[];
  cnArticles: Article[];
  jpArticles: Article[];
  pairs: ArticlePair[];
  stats: RefreshStats;
  warnings: string[];
};
