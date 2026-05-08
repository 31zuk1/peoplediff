import type { Source } from "./types";

export type PeopleLanguage = Source;

export type PeopleLanguageGroup = "base" | "foreign" | "ethnic";

export type PeopleLanguageConfig = {
  code: PeopleLanguage;
  label: string;
  nativeName: string;
  editionLabel: string;
  locale: string;
  group: PeopleLanguageGroup;
  enabled: boolean;
  homeUrl: string;
  articleHosts: string[];
  allArticlesUrl?: string;
  minTitleLength: number;
  defaultDailyMaxPages: number;
  summaryLength: number;
  warningLabel: string;
};

export const DEFAULT_SOURCE_LANGUAGE: PeopleLanguage = "CN";
export const DEFAULT_TARGET_LANGUAGE: PeopleLanguage = "JP";

const foreignDefaults = {
  group: "foreign" as const,
  enabled: true,
  minTitleLength: 5,
  defaultDailyMaxPages: 3,
  summaryLength: 180
};

const ethnicDefaults = {
  group: "ethnic" as const,
  enabled: true,
  minTitleLength: 4,
  defaultDailyMaxPages: 2,
  summaryLength: 180
};

export const PEOPLE_LANGUAGES: Record<PeopleLanguage, PeopleLanguageConfig> = {
  CN: {
    code: "CN",
    label: "Chinese",
    nativeName: "中文",
    editionLabel: "中国語版",
    locale: "zh-CN",
    group: "base",
    enabled: true,
    homeUrl: "https://www.people.com.cn/",
    articleHosts: ["www.people.com.cn"],
    minTitleLength: 6,
    defaultDailyMaxPages: 5,
    summaryLength: 160,
    warningLabel: "中国語版"
  },
  EN: {
    ...foreignDefaults,
    code: "EN",
    label: "English",
    nativeName: "English",
    editionLabel: "英語版",
    locale: "en",
    homeUrl: "https://en.people.cn/",
    articleHosts: ["en.people.cn", "english.people.com.cn"],
    allArticlesUrl: "https://en.people.cn/102842/index.html",
    warningLabel: "英語版"
  },
  JP: {
    ...foreignDefaults,
    code: "JP",
    label: "Japanese",
    nativeName: "日本語",
    editionLabel: "日本語版",
    locale: "ja-JP",
    homeUrl: "https://j.people.com.cn/",
    articleHosts: ["j.people.com.cn", "j.peopledaily.com.cn"],
    allArticlesUrl: "https://j.people.com.cn/94765/index.html",
    warningLabel: "日本語版"
  },
  FR: {
    ...foreignDefaults,
    code: "FR",
    label: "French",
    nativeName: "Français",
    editionLabel: "仏語版",
    locale: "fr",
    homeUrl: "https://french.people.com.cn/",
    articleHosts: ["french.people.com.cn"],
    warningLabel: "仏語版"
  },
  ES: {
    ...foreignDefaults,
    code: "ES",
    label: "Spanish",
    nativeName: "Español",
    editionLabel: "スペイン語版",
    locale: "es",
    homeUrl: "https://spanish.people.com.cn/",
    articleHosts: ["spanish.people.com.cn"],
    warningLabel: "スペイン語版"
  },
  RU: {
    ...foreignDefaults,
    code: "RU",
    label: "Russian",
    nativeName: "Русский",
    editionLabel: "ロシア語版",
    locale: "ru",
    homeUrl: "https://russian.people.com.cn/",
    articleHosts: ["russian.people.com.cn"],
    warningLabel: "ロシア語版"
  },
  AR: {
    ...foreignDefaults,
    code: "AR",
    label: "Arabic",
    nativeName: "عربي",
    editionLabel: "アラビア語版",
    locale: "ar",
    homeUrl: "https://arabic.people.com.cn/",
    articleHosts: ["arabic.people.com.cn"],
    warningLabel: "アラビア語版"
  },
  KO: {
    ...foreignDefaults,
    code: "KO",
    label: "Korean",
    nativeName: "한국어",
    editionLabel: "韓国語版",
    locale: "ko",
    homeUrl: "https://kr.people.com.cn/",
    articleHosts: ["kr.people.com.cn"],
    warningLabel: "韓国語版"
  },
  DE: {
    ...foreignDefaults,
    code: "DE",
    label: "German",
    nativeName: "Deutsch",
    editionLabel: "独語版",
    locale: "de",
    homeUrl: "https://german.people.com.cn/",
    articleHosts: ["german.people.com.cn"],
    warningLabel: "独語版"
  },
  PT: {
    ...foreignDefaults,
    code: "PT",
    label: "Portuguese",
    nativeName: "Português",
    editionLabel: "ポルトガル語版",
    locale: "pt",
    homeUrl: "https://portuguese.people.com.cn/",
    articleHosts: ["portuguese.people.com.cn"],
    warningLabel: "ポルトガル語版"
  },
  SW: {
    ...foreignDefaults,
    code: "SW",
    label: "Swahili",
    nativeName: "Kiswahili",
    editionLabel: "スワヒリ語版",
    locale: "sw",
    homeUrl: "https://swahili.people.cn/",
    articleHosts: ["www.swahili.people.cn", "swahili.people.cn"],
    warningLabel: "スワヒリ語版"
  },
  IT: {
    ...foreignDefaults,
    code: "IT",
    label: "Italian",
    nativeName: "Italiano",
    editionLabel: "イタリア語版",
    locale: "it",
    homeUrl: "https://italian.people.cn/",
    articleHosts: ["www.italian.people.cn", "italian.people.cn"],
    warningLabel: "イタリア語版"
  },
  KK: {
    ...foreignDefaults,
    code: "KK",
    label: "Kazakh",
    nativeName: "Қазақ тілі",
    editionLabel: "カザフ語版",
    locale: "kk",
    homeUrl: "https://kaz.people.cn/",
    articleHosts: ["www.kaz.people.cn", "kaz.people.cn"],
    warningLabel: "カザフ語版"
  },
  TH: {
    ...foreignDefaults,
    code: "TH",
    label: "Thai",
    nativeName: "ภาษาไทย",
    editionLabel: "タイ語版",
    locale: "th",
    homeUrl: "https://thai.people.cn/",
    articleHosts: ["www.thai.people.cn", "thai.people.cn"],
    warningLabel: "タイ語版"
  },
  MS: {
    ...foreignDefaults,
    code: "MS",
    label: "Malay",
    nativeName: "Bahasa Melayu",
    editionLabel: "マレー語版",
    locale: "ms",
    homeUrl: "https://malay.people.cn/",
    articleHosts: ["www.malay.people.cn", "malay.people.cn"],
    warningLabel: "マレー語版"
  },
  EL: {
    ...foreignDefaults,
    code: "EL",
    label: "Greek",
    nativeName: "Ελληνικά",
    editionLabel: "ギリシャ語版",
    locale: "el",
    homeUrl: "https://greek.people.cn/",
    articleHosts: ["www.greek.people.cn", "greek.people.cn"],
    warningLabel: "ギリシャ語版"
  },
  VI: {
    ...foreignDefaults,
    code: "VI",
    label: "Vietnamese",
    nativeName: "Tiếng Việt",
    editionLabel: "ベトナム語版",
    locale: "vi",
    homeUrl: "https://vietnamese.people.cn/",
    articleHosts: ["vietnamese.people.cn"],
    warningLabel: "ベトナム語版"
  },
  UR: {
    ...foreignDefaults,
    code: "UR",
    label: "Urdu",
    nativeName: "اردو",
    editionLabel: "ウルドゥー語版",
    locale: "ur",
    homeUrl: "https://urdu.people.cn/",
    articleHosts: ["urdu.people.cn"],
    warningLabel: "ウルドゥー語版"
  },
  HI: {
    ...foreignDefaults,
    code: "HI",
    label: "Hindi",
    nativeName: "हिन्दी",
    editionLabel: "ヒンディー語版",
    locale: "hi",
    homeUrl: "https://hindi.people.cn/",
    articleHosts: ["hindi.people.cn"],
    warningLabel: "ヒンディー語版"
  },
  MN: {
    ...ethnicDefaults,
    code: "MN",
    label: "Mongolian",
    nativeName: "Монгол",
    editionLabel: "モンゴル語版",
    locale: "mn",
    homeUrl: "http://mongol.people.com.cn/",
    articleHosts: ["mongol.people.com.cn"],
    warningLabel: "モンゴル語版"
  },
  BO: {
    ...ethnicDefaults,
    code: "BO",
    label: "Tibetan",
    nativeName: "藏文",
    editionLabel: "チベット語版",
    locale: "bo",
    homeUrl: "http://tibet.people.com.cn/",
    articleHosts: ["tibet.people.com.cn"],
    warningLabel: "チベット語版"
  },
  UG: {
    ...ethnicDefaults,
    code: "UG",
    label: "Uyghur",
    nativeName: "ئۇيغۇرچە",
    editionLabel: "ウイグル語版",
    locale: "ug",
    homeUrl: "http://uyghur.people.com.cn/",
    articleHosts: ["uyghur.people.com.cn"],
    warningLabel: "ウイグル語版"
  },
  KK_CN: {
    ...ethnicDefaults,
    code: "KK_CN",
    label: "Kazakh (China)",
    nativeName: "哈文",
    editionLabel: "哈文版",
    locale: "kk-CN",
    homeUrl: "http://kazakh.people.com.cn/",
    articleHosts: ["kazakh.people.com.cn"],
    warningLabel: "哈文版"
  },
  KO_CN: {
    ...ethnicDefaults,
    code: "KO_CN",
    label: "Korean (China)",
    nativeName: "朝鲜文",
    editionLabel: "朝鮮文版",
    locale: "ko-CN",
    homeUrl: "http://korean.people.com.cn/",
    articleHosts: ["korean.people.com.cn"],
    warningLabel: "朝鮮文版"
  },
  YI: {
    ...ethnicDefaults,
    code: "YI",
    label: "Yi",
    nativeName: "彝文",
    editionLabel: "彝文版",
    locale: "ii",
    homeUrl: "https://yi.people.com.cn/",
    articleHosts: ["yi.people.com.cn"],
    warningLabel: "彝文版"
  },
  ZA: {
    ...ethnicDefaults,
    code: "ZA",
    label: "Zhuang",
    nativeName: "壮文",
    editionLabel: "壮文版",
    locale: "za",
    homeUrl: "http://sawcuengh.people.com.cn/",
    articleHosts: ["sawcuengh.people.com.cn"],
    warningLabel: "壮文版"
  }
};

export const PEOPLE_LANGUAGE_CODES = Object.keys(PEOPLE_LANGUAGES) as PeopleLanguage[];

export const TARGET_LANGUAGE_CODES = PEOPLE_LANGUAGE_CODES.filter((code) => code !== "CN");

export type CompareLanguageSelection = {
  sourceLanguage: PeopleLanguage;
  targetLanguage: PeopleLanguage;
  warnings: string[];
};

export function getPeopleLanguageConfig(language: PeopleLanguage) {
  return PEOPLE_LANGUAGES[language] ?? PEOPLE_LANGUAGES[DEFAULT_TARGET_LANGUAGE];
}

export function getAvailableLanguageSummaries() {
  return PEOPLE_LANGUAGE_CODES.map((code) => {
    const config = PEOPLE_LANGUAGES[code];
    return {
      code,
      label: config.label,
      nativeName: config.nativeName,
      editionLabel: config.editionLabel,
      group: config.group,
      enabled: config.enabled
    };
  });
}

export function resolveCompareLanguages(
  input: {
    sourceLanguage?: unknown;
    targetLanguage?: unknown;
    source?: unknown;
    target?: unknown;
  } = {}
): CompareLanguageSelection {
  const warnings: string[] = [];
  const sourceValue = input.sourceLanguage ?? input.source;
  const targetValue = input.targetLanguage ?? input.target;
  const requestedSource = languageFromInput(sourceValue);
  const requestedTarget = languageFromInput(targetValue);
  let sourceLanguage = requestedSource ?? DEFAULT_SOURCE_LANGUAGE;
  let targetLanguage = requestedTarget ?? DEFAULT_TARGET_LANGUAGE;

  if (sourceValue != null && !requestedSource) {
    warnings.push(`未対応のsourceLanguage "${String(sourceValue)}" はCNとして扱いました。`);
  }

  if (targetValue != null && !requestedTarget) {
    warnings.push(`未対応のtargetLanguage "${String(targetValue)}" はJPとして扱いました。`);
  }

  if (sourceLanguage !== DEFAULT_SOURCE_LANGUAGE) {
    warnings.push("現時点の基準言語はCN固定です。sourceLanguageはCNとして扱いました。");
    sourceLanguage = DEFAULT_SOURCE_LANGUAGE;
  }

  if (targetLanguage === sourceLanguage) {
    warnings.push("対象言語が基準言語と同じため、targetLanguageはJPとして扱いました。");
    targetLanguage = DEFAULT_TARGET_LANGUAGE;
  }

  return { sourceLanguage, targetLanguage, warnings };
}

function languageFromInput(input: unknown) {
  if (typeof input !== "string") return undefined;
  const key = input.trim().normalize("NFKC").replace(/[-_\s]/g, "").toUpperCase();
  return LANGUAGE_ALIASES[key];
}

const LANGUAGE_ALIASES: Record<string, PeopleLanguage> = {
  CN: "CN",
  CH: "CN",
  ZH: "CN",
  ZHCN: "CN",
  CHINESE: "CN",
  CHINA: "CN",
  "中国語": "CN",
  "中文": "CN",
  EN: "EN",
  ENG: "EN",
  ENGLISH: "EN",
  JP: "JP",
  JA: "JP",
  JPN: "JP",
  JAPANESE: "JP",
  "日本語": "JP",
  FR: "FR",
  FRA: "FR",
  FRENCH: "FR",
  ES: "ES",
  SPA: "ES",
  SPANISH: "ES",
  RU: "RU",
  RUS: "RU",
  RUSSIAN: "RU",
  AR: "AR",
  ARA: "AR",
  ARABIC: "AR",
  KO: "KO",
  KR: "KO",
  KOREAN: "KO",
  DE: "DE",
  GER: "DE",
  GERMAN: "DE",
  PT: "PT",
  POR: "PT",
  PORTUGUESE: "PT",
  SW: "SW",
  SWAHILI: "SW",
  KISWAHILI: "SW",
  IT: "IT",
  ITALIAN: "IT",
  KK: "KK",
  KAZ: "KK",
  KAZAKH: "KK",
  TH: "TH",
  THAI: "TH",
  MS: "MS",
  MALAY: "MS",
  EL: "EL",
  GR: "EL",
  GREEK: "EL",
  VI: "VI",
  VN: "VI",
  VIETNAMESE: "VI",
  UR: "UR",
  URDU: "UR",
  HI: "HI",
  HINDI: "HI",
  MN: "MN",
  MONGOL: "MN",
  MONGOLIAN: "MN",
  BO: "BO",
  TIBETAN: "BO",
  UG: "UG",
  UYGHUR: "UG",
  UIGHUR: "UG",
  KKCN: "KK_CN",
  KAZAKHCN: "KK_CN",
  KOCN: "KO_CN",
  KOREANCN: "KO_CN",
  YI: "YI",
  ZA: "ZA",
  ZHUANG: "ZA"
};
