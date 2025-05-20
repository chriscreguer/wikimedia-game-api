// Wikimedia API response interfaces


export interface WikimediaImage {
  url: string;
  title: string;
  source: string;
  year: number;
  description?: string;
  filename?: string;
  revealedDescription?: string;
  s3BaseKey?: string;
  s3BaseIdentifier?: string;
}

export interface GuessHistoryItem {
  year: number;
  correct: boolean;
  direction?: 'higher' | 'lower' | null;
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

  
export interface GameState {
  image: WikimediaImage | null;
  loading: boolean;
  round: number;
  totalRounds: number;
  guessesLeft: number;
  maxGuesses: number;
  skipsLeft: number;
  maxSkips: number;
  actualYear: number | null;
  lowerBound: number;
  upperBound: number;
  correctGuesses: number;
  score: number;
  hintRequested: boolean;
  hintPenalty: number;
  hasGuessed: boolean;
  streak: number;
  yearInput: string[];
  gameOver: boolean;
  lastGuess: number | null;
  guessDirection: 'higher' | 'lower' | null;
  feedback: string;
  showFeedback: boolean;
  guessHistory: GuessHistoryItem[];
}