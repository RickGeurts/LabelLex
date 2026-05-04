export type ValueType = "string" | "enum" | "bool" | "number" | "date";

export interface AttributeDefinition {
  id: number;
  label_id: number;
  name: string;
  value_type: ValueType;
  enum_values: string[] | null;
  required: boolean;
  description: string | null;
}

export interface AttributeCreate {
  name: string;
  value_type: ValueType;
  enum_values?: string[] | null;
  required?: boolean;
  description?: string | null;
}

export interface AttributeUpdate {
  name?: string;
  value_type?: ValueType;
  enum_values?: string[] | null;
  required?: boolean;
  description?: string | null;
}

export interface Label {
  id: number;
  project_id: number;
  parent_id: number | null;
  name: string;
  color: string;
  description: string | null;
  attributes: AttributeDefinition[];
  annotation_count: number;
}

export interface LabelCreate {
  name: string;
  color?: string;
  description?: string | null;
  parent_id?: number | null;
}

export interface LabelUpdate {
  name?: string;
  color?: string;
  description?: string | null;
  parent_id?: number | null;
}

export interface Project {
  id: number;
  name: string;
  owner_id: number;
  created_at: string;
  labels: Label[];
}

export interface Document {
  id: number;
  project_id: number;
  category_id: number | null;
  filename: string;
  page_count: number;
  status: string;
  uploaded_by: number;
  uploaded_at: string;
  last_modified_at: string;
  annotation_count: number;
}

export interface DocumentUpdate {
  category_id?: number | null;
}

export interface DocumentCategory {
  id: number;
  project_id: number;
  name: string;
  description: string | null;
  color: string;
  created_at: string;
}

export interface DocumentCategoryCreate {
  name: string;
  description?: string | null;
  color?: string;
}

export interface DocumentCategoryUpdate {
  name?: string;
  description?: string | null;
  color?: string;
}

export interface ProjectCreate {
  name: string;
}

export interface Word {
  char_start: number;
  char_end: number;
  text: string;
  bbox: [number, number, number, number]; // PDF point coords (y-down from top-left)
  block: number;
  line: number;
}

export interface Page {
  id: number;
  page_num: number;
  printed_page_num: string | null;
  width: number;
  height: number;
  text: string;
  words: Word[];
}

export interface AnnotationAttributeIO {
  attribute_def_id: number;
  value: unknown;
}

export interface Annotation {
  id: number;
  document_id: number;
  label_definition_id: number;
  start_page_num: number;
  start_char: number;
  end_page_num: number;
  end_char: number;
  text: string;
  created_by: number;
  created_at: string;
  attributes: AnnotationAttributeIO[];
}

export interface AnnotationCreate {
  document_id: number;
  label_definition_id: number;
  start_page_num: number;
  start_char: number;
  end_page_num: number;
  end_char: number;
  text: string;
  attributes?: AnnotationAttributeIO[];
  suggestion_id?: number;
}

export interface AnnotationUpdate {
  attributes?: AnnotationAttributeIO[];
  // Span edit — all four span fields plus text must travel together.
  start_page_num?: number;
  start_char?: number;
  end_page_num?: number;
  end_char?: number;
  text?: string;
  suggestion_id?: number;
}

export interface SearchHit {
  page_num: number;
  char_start: number;
  char_end: number;
  snippet: string;
  match_in_snippet: number;
}

export interface OllamaStatus {
  reachable: boolean;
  error: string | null;
  base_url: string;
  configured_model: string;
  configured_model_available: boolean;
  models: string[];
}

export interface DetectedSection {
  title: string;
  page_num: number;
  section_type: string;
  confidence: number;
}

export interface DetectStructureResponse {
  document_id: number;
  model: string;
  sections: DetectedSection[];
}

export interface SuggestAttributesIn {
  document_id: number;
  label_definition_id: number;
  text: string;
  start_page_num?: number;
  start_char?: number;
  end_page_num?: number;
  end_char?: number;
}

export interface SuggestedAttribute {
  attribute_def_id: number;
  value: unknown;
}

export interface SuggestAttributesOut {
  suggestion_id: number;
  strategy: string;
  model: string;
  confidence: number;
  attributes: SuggestedAttribute[];
}

export interface PrelabelRequest {
  start_page_num: number;
  end_page_num: number;
  label_definition_ids?: number[] | null;
}

export interface PrelabelCandidate {
  suggestion_id: number;
  label_definition_id: number;
  start_page_num: number;
  start_char: number;
  end_page_num: number;
  end_char: number;
  text: string;
  confidence: number;
}

export type PrelabelEvent =
  | { type: "started"; model: string; total_pages: number }
  | {
      type: "page_done";
      page_num: number;
      pages_done: number;
      pages_total: number;
      candidates: PrelabelCandidate[];
    }
  | { type: "done" }
  | { type: "error"; message: string };

export interface SuggestionListItem {
  id: number;
  document_id: number;
  label_definition_id: number;
  text: string;
  start_page_num: number | null;
  start_char: number | null;
  end_page_num: number | null;
  end_char: number | null;
  strategy: string;
  model: string;
  confidence: number;
  suggested_attributes: SuggestedAttribute[];
  status: string;
  annotation_id: number | null;
  created_at: string;
}