// Wikimedia API response interfaces

export interface WikimediaImage {
  title: string;
  url: string;
  year: number;
  source: string;
}

export interface WikimediaMetadataField {
  value: string;
  source?: string;
}

export interface WikimediaExtMetadata {
  DateTimeOriginal?: WikimediaMetadataField;
  DateTime?: WikimediaMetadataField;
  date?: WikimediaMetadataField;
  Artist?: WikimediaMetadataField;
  [key: string]: WikimediaMetadataField | undefined;
}

export interface WikimediaImageInfo {
  url: string;
  extmetadata?: WikimediaExtMetadata;
}

export interface WikimediaPage {
  pageid: number;
  ns: number;
  title: string;
  imageinfo?: WikimediaImageInfo[];
}

export interface WikimediaQueryResponse {
  batchcomplete?: string;
  query?: {
    pages?: {
      [key: string]: WikimediaPage;
    };
  };
}

export interface ImageCache {
  items: WikimediaImage[];
  lastUpdate: number | null;
}

  
  interface GameState {
    image: WikimediaImage | null;
    actualYear: number | null;
    userGuess: string;
    score: number;
    feedback: string;
    loading: boolean;
    error: string | null;
    guessed: boolean;
    roundCount: number;
    attempts: number;
    maxAttempts: number;
  }