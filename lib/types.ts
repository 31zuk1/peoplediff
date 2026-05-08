export type Source =
  | "CN"
  | "EN"
  | "JP"
  | "FR"
  | "ES"
  | "RU"
  | "AR"
  | "KO"
  | "DE"
  | "PT"
  | "SW"
  | "IT"
  | "KK"
  | "TH"
  | "MS"
  | "EL"
  | "VI"
  | "UR"
  | "HI"
  | "MN"
  | "BO"
  | "UG"
  | "KK_CN"
  | "KO_CN"
  | "YI"
  | "ZA";

export type PairStatus =
  | "MATCHED"
  | "CN ONLY"
  | "JP ONLY"
  | "TARGET ONLY"
  | "FRAMING SHIFT"
  | "BODY DIFFERENCE";

export type VisibilityStatus = "MATCHED" | "BASE_ONLY" | "TARGET_ONLY";

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
  visibilityStatus?: VisibilityStatus;
  base?: Article;
  target?: Article;
  cn?: Article;
  jp?: Article;
  sourceLanguage?: Source;
  targetLanguage?: Source;
  articlesBySource?: Partial<Record<Source, Article>>;
  onlySource?: Source;
  matchScore: number;
  analysis?: DifferenceAnalysis;
  highlights: string[];
};

export type RefreshStats = {
  cnCount: number;
  jpCount: number;
  baseCount?: number;
  targetCount?: number;
  countsBySource?: Partial<Record<Source, number>>;
  cnDateCounts: Record<string, number>;
  jpDateCounts: Record<string, number>;
  dateCountsBySource?: Partial<Record<Source, Record<string, number>>>;
  dateMismatches: number;
  matched: number;
  cnOnly: number;
  jpOnly: number;
  baseOnly?: number;
  targetOnly?: number;
  framingShift: number;
  bodyDifference: number;
  coverageRatio: number;
};

export type RefreshResult = {
  generatedAt: string;
  mode: "live" | "demo" | "empty";
  model: string;
  schemaVersion?: number;
  refreshSignature?: string;
  baseLanguage?: Source;
  targetLanguage?: Source;
  availableLanguages?: Array<{
    code: Source;
    label: string;
    nativeName: string;
    editionLabel: string;
    group: "base" | "foreign" | "ethnic";
    enabled: boolean;
  }>;
  activeDate?: string;
  archiveDates?: string[];
  dateScope?: string[];
  sourceDateScope?: string[];
  targetDateScope?: string[];
  sourceLookbackDays?: number;
  baseArticles?: Article[];
  targetArticles?: Article[];
  cnArticles: Article[];
  jpArticles: Article[];
  pairs: ArticlePair[];
  stats: RefreshStats;
  warnings: string[];
};
