import { FormDefinition, FormQuestion, FormQuestionType } from '../../core/services/api.service';

export type { FormDefinition, FormQuestion, FormQuestionType, FormSummary } from '../../core/services/api.service';

/** crypto.randomUUID solo existe en contextos seguros (HTTPS/localhost); QA se sirve por HTTP. */
export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Tipos de pregunta con su etiqueta en español para el selector del editor. */
export const QUESTION_TYPES: { value: FormQuestionType; label: string }[] = [
  { value: 'short_text', label: 'Texto corto' },
  { value: 'long_text', label: 'Texto largo' },
  { value: 'number', label: 'Número' },
  { value: 'date', label: 'Fecha' },
  { value: 'checkbox', label: 'Casilla' },
  { value: 'radio', label: 'Selección única' },
  { value: 'select', label: 'Lista desplegable' },
];

/** Definición inicial de un formulario nuevo (borrador de ejemplo). */
export function createForm(): FormDefinition {
  return {
    id: newId(),
    name: 'Solicitud de servicio',
    description: 'Formulario creado con ComprePDF.',
    page_size: 'letter',
    header: {
      title: 'Solicitud de servicio',
      subtitle: 'Complete los campos indicados antes de enviar el documento.',
    },
    footer: {
      text: 'Información de uso interno',
      show_page_numbers: true,
    },
    questions: [
      createQuestion('short_text', 1, 'Nombre completo'),
      createQuestion('checkbox', 2, 'Confirmo que los datos son correctos'),
      {
        ...createQuestion('radio', 3, 'Prioridad de la solicitud'),
        options: ['Normal', 'Urgente'],
      },
    ],
  };
}

export function createQuestion(
  type: FormQuestionType,
  position: number,
  label = 'Nueva pregunta',
): FormQuestion {
  return {
    id: newId(),
    name: `campo_${position}`,
    type,
    label,
    help_text: '',
    required: false,
    options: type === 'radio' || type === 'select' ? ['Opción 1', 'Opción 2'] : [],
  };
}
