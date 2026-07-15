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

export interface FormQuestion {
  id?: string;
  name: string;
  type: QuestionType;
  label: string;
  help_text: string;
  required: boolean;
  options: string[];
}

export interface FormDefinition {
  id?: string;
  name: string;
  description: string;
  page_size: PageSize;
  header: { title: string; subtitle: string };
  footer: { text: string; show_page_numbers: boolean };
  questions: FormQuestion[];
  version?: number;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asBool(value: unknown): boolean {
  return value === true || value === 'true';
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

function validateQuestion(raw: unknown, index: number): FormQuestion {
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

  return {
    id: typeof q.id === 'string' ? q.id : undefined,
    name,
    type,
    label,
    help_text: helpText,
    required: asBool(q.required),
    options: OPTION_TYPES.includes(type) ? options : [],
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

  const questionsRaw = Array.isArray(body.questions) ? body.questions : [];
  if (questionsRaw.length > 100) {
    throw new ValidationError('A form cannot have more than 100 questions');
  }
  const questions = questionsRaw.map((q, i) => validateQuestion(q, i));

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
    questions,
  };
}
