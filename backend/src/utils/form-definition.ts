import { ValidationError } from './errors';

/**
 * Validación y normalización de una definición de formulario PDF.
 *
 * Es el equivalente en TypeScript de los `model_validator` de Pydantic del
 * proyecto original (`gestor-formularios-pdf`). El worker vuelve a defenderse,
 * pero el backend es la primera línea: rechaza definiciones inválidas con 400
 * y devuelve un objeto limpio (opciones recortadas, defaults aplicados) que se
 * persiste tal cual y se envía al worker.
 */

export type PageSize = 'letter' | 'a4';
export type QuestionType =
  | 'short_text'
  | 'long_text'
  | 'number'
  | 'date'
  | 'checkbox'
  | 'radio'
  | 'select';

const QUESTION_TYPES: QuestionType[] = [
  'short_text', 'long_text', 'number', 'date', 'checkbox', 'radio', 'select',
];
const OPTION_TYPES: QuestionType[] = ['radio', 'select'];

/** Nombre interno del campo (AcroForm): letra inicial + [A-Za-z0-9_], 2-64 chars. */
const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{1,63}$/;

/** Columnas por sección: más de 3 deja las etiquetas ilegibles en Letter/A4. */
export const MAX_COLUMNS = 3;
const MAX_SECTIONS = 20;
const MAX_QUESTIONS = 100;

export interface FormQuestion {
  id?: string;
  name: string;
  type: QuestionType;
  label: string;
  help_text: string;
  required: boolean;
  options: string[];
  /** Columnas que ocupa dentro de su sección (1..section.columns). */
  column_span: number;
}

export interface FormSection {
  id?: string;
  /** Etiqueta del grupo; vacía = sección sin encabezado. */
  title: string;
  columns: number;
  page_break: boolean;
  questions: FormQuestion[];
}

export interface FormDefinition {
  id?: string;
  name: string;
  description: string;
  page_size: PageSize;
  header: { title: string; subtitle: string };
  footer: { text: string; show_page_numbers: boolean };
  sections: FormSection[];
  /**
   * Espejo derivado de `sections`: todas las preguntas aplanadas en orden. Lo
   * emitimos siempre para que un worker anterior a las secciones siga
   * renderizando el formulario (a una columna) en vez de un PDF vacío, y para
   * que `questionCount` del controlador siga valiendo. Nadie lo escribe: se
   * calcula solo en el `return` de `validateFormDefinition`.
   */
  questions: FormQuestion[];
  version?: number;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asBool(value: unknown): boolean {
  return value === true || value === 'true';
}

/** Entero tolerante con strings numéricos. `undefined` si falta; `NaN` si no es entero. */
function asInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : NaN;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return parseInt(value.trim(), 10);
  }
  return NaN;
}

function requireLen(value: string, field: string, max: number, min = 0): string {
  if (value.length < min) {
    throw new ValidationError(`${field} is required`);
  }
  if (value.length > max) {
    throw new ValidationError(`${field} must be at most ${max} characters`);
  }
  return value;
}

function validateQuestion(raw: unknown, index: number, maxColumns: number): FormQuestion {
  if (!raw || typeof raw !== 'object') {
    throw new ValidationError(`Question ${index + 1} is invalid`);
  }
  const q = raw as Record<string, unknown>;

  const type = asString(q.type) as QuestionType;
  if (!QUESTION_TYPES.includes(type)) {
    throw new ValidationError(`Question ${index + 1} has an invalid type "${asString(q.type)}"`);
  }

  const name = asString(q.name).trim();
  if (!NAME_PATTERN.test(name)) {
    throw new ValidationError(
      `Field name "${name}" is invalid: start with a letter and use only letters, numbers or "_" (2-64 chars)`,
    );
  }

  const label = requireLen(asString(q.label).trim(), `Question "${name}" label`, 240, 1);
  const helpText = requireLen(asString(q.help_text).trim(), `Question "${name}" help text`, 300);

  const rawOptions = Array.isArray(q.options) ? q.options : [];
  if (rawOptions.length > 30) {
    throw new ValidationError(`Question "${name}" cannot have more than 30 options`);
  }
  const options = rawOptions.map((o) => asString(o).trim()).filter(Boolean);

  if (OPTION_TYPES.includes(type)) {
    if (options.length < 2) {
      throw new ValidationError(`Question "${name}" (choice) needs at least two options`);
    }
    if (new Set(options).size !== options.length) {
      throw new ValidationError(`Question "${name}" has duplicated options`);
    }
  }

  const spanRaw = asInt(q.column_span);
  const columnSpan = spanRaw === undefined ? 1 : spanRaw;
  if (!Number.isInteger(columnSpan) || columnSpan < 1) {
    throw new ValidationError(`Question "${name}" has an invalid column_span`);
  }
  if (columnSpan > maxColumns) {
    throw new ValidationError(
      `Question "${name}" spans ${columnSpan} columns but its section only has ${maxColumns}`,
    );
  }

  return {
    id: typeof q.id === 'string' ? q.id : undefined,
    name,
    type,
    label,
    help_text: helpText,
    required: asBool(q.required),
    options: OPTION_TYPES.includes(type) ? options : [],
    column_span: columnSpan,
  };
}

/**
 * Valida una sección. `offset` es el número de preguntas ya vistas en secciones
 * anteriores, para que los errores sigan numerando de forma global ("Question 7")
 * y no reinicien la cuenta en cada sección.
 */
function validateSection(raw: unknown, index: number, offset: number): FormSection {
  if (!raw || typeof raw !== 'object') {
    throw new ValidationError(`Section ${index + 1} is invalid`);
  }
  const s = raw as Record<string, unknown>;

  const title = requireLen(asString(s.title).trim(), `Section ${index + 1} title`, 120);

  const columnsRaw = asInt(s.columns);
  const columns = columnsRaw === undefined ? 1 : columnsRaw;
  if (!Number.isInteger(columns) || columns < 1 || columns > MAX_COLUMNS) {
    throw new ValidationError(
      `Section ${index + 1} must have between 1 and ${MAX_COLUMNS} columns`,
    );
  }

  const questionsRaw = Array.isArray(s.questions) ? s.questions : [];
  const questions = questionsRaw.map((q, i) => validateQuestion(q, offset + i, columns));

  return {
    id: typeof s.id === 'string' ? s.id : undefined,
    title,
    columns,
    page_break: asBool(s.page_break),
    questions,
  };
}

/**
 * Valida y normaliza una definición cruda (body de la request). Lanza
 * `ValidationError` (400) ante el primer problema; en éxito devuelve un objeto
 * limpio listo para persistir/generar.
 */
export function validateFormDefinition(raw: unknown): FormDefinition {
  if (!raw || typeof raw !== 'object') {
    throw new ValidationError('Form definition is required');
  }
  const body = raw as Record<string, unknown>;

  const name = requireLen(asString(body.name).trim(), 'Form name', 120, 1);
  const description = requireLen(asString(body.description).trim(), 'Description', 500);

  const pageSizeRaw = asString(body.page_size).trim().toLowerCase() || 'letter';
  if (pageSizeRaw !== 'letter' && pageSizeRaw !== 'a4') {
    throw new ValidationError('page_size must be "letter" or "a4"');
  }
  const page_size = pageSizeRaw as PageSize;

  const headerRaw = (body.header && typeof body.header === 'object' ? body.header : {}) as Record<string, unknown>;
  const title = requireLen(asString(headerRaw.title).trim(), 'Header title', 120, 1);
  const subtitle = requireLen(asString(headerRaw.subtitle).trim(), 'Header subtitle', 240);

  const footerRaw = (body.footer && typeof body.footer === 'object' ? body.footer : {}) as Record<string, unknown>;
  const footerText = requireLen(asString(footerRaw.text).trim(), 'Footer text', 160);
  const showPageNumbers = footerRaw.show_page_numbers === undefined ? true : asBool(footerRaw.show_page_numbers);

  // `sections` manda: si viene, el `questions` de entrada se ignora por completo
  // (es un espejo derivado, no una fuente de verdad). Si no viene, el payload es
  // de antes de las secciones y lo envolvemos en una sección implícita sin
  // título, que renderiza igual que siempre. Esto es obligatorio: `generateForm`
  // revalida payloads ya guardados en la BD.
  const sections = Array.isArray(body.sections)
    ? validateSections(body.sections)
    : [wrapLegacyQuestions(body.questions)];

  const questions = sections.flatMap((s) => s.questions);

  // Unicidad GLOBAL, no por sección: el AcroForm es plano y dos campos con el
  // mismo nombre se fusionan en uno con dos widgets (se escribe en uno y aparece
  // en el otro).
  const names = questions.map((q) => q.name);
  if (new Set(names).size !== names.length) {
    throw new ValidationError('Each question must have a unique internal name');
  }

  return {
    id: typeof body.id === 'string' ? body.id : undefined,
    name,
    description,
    page_size,
    header: { title, subtitle },
    footer: { text: footerText, show_page_numbers: showPageNumbers },
    sections,
    questions,
  };
}

function validateSections(raw: unknown[]): FormSection[] {
  if (raw.length > MAX_SECTIONS) {
    throw new ValidationError(`A form cannot have more than ${MAX_SECTIONS} sections`);
  }
  const sections: FormSection[] = [];
  let total = 0;
  raw.forEach((s, i) => {
    const section = validateSection(s, i, total);
    total += section.questions.length;
    if (total > MAX_QUESTIONS) {
      throw new ValidationError(`A form cannot have more than ${MAX_QUESTIONS} questions`);
    }
    sections.push(section);
  });
  return sections;
}

/** Payload anterior a las secciones: `questions` plano -> sección implícita. */
function wrapLegacyQuestions(raw: unknown): FormSection {
  const questionsRaw = Array.isArray(raw) ? raw : [];
  if (questionsRaw.length > MAX_QUESTIONS) {
    throw new ValidationError(`A form cannot have more than ${MAX_QUESTIONS} questions`);
  }
  return {
    id: undefined,
    title: '',
    columns: 1,
    page_break: false,
    questions: questionsRaw.map((q, i) => validateQuestion(q, i, 1)),
  };
}
