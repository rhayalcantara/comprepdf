import { validateFormDefinition } from '../../src/utils/form-definition';
import { ValidationError } from '../../src/utils/errors';

/** Definición mínima válida; los tests la mutan para probar cada regla. */
function validRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Solicitud',
    description: '',
    page_size: 'letter',
    header: { title: 'Solicitud de servicio', subtitle: '' },
    footer: { text: '', show_page_numbers: true },
    questions: [
      { name: 'nombre', type: 'short_text', label: 'Nombre', help_text: '', required: true, options: [] },
      { name: 'prioridad', type: 'radio', label: 'Prioridad', help_text: '', required: false, options: ['A', 'B'] },
    ],
    ...overrides,
  };
}

describe('validateFormDefinition', () => {
  it('acepta una definición válida y la normaliza', () => {
    const def = validateFormDefinition(validRaw());
    expect(def.name).toBe('Solicitud');
    expect(def.page_size).toBe('letter');
    expect(def.header.title).toBe('Solicitud de servicio');
    expect(def.questions).toHaveLength(2);
  });

  it('page_size ausente cae en "letter"', () => {
    const raw = validRaw();
    delete raw.page_size;
    expect(validateFormDefinition(raw).page_size).toBe('letter');
  });

  it('show_page_numbers ausente cae en true', () => {
    const raw = validRaw({ footer: { text: '' } });
    expect(validateFormDefinition(raw).footer.show_page_numbers).toBe(true);
  });

  it('recorta y descarta opciones vacías', () => {
    const raw = validRaw({
      questions: [
        { name: 'prioridad', type: 'select', label: 'P', help_text: '', required: false, options: [' A ', '', 'B', '  '] },
      ],
    });
    expect(validateFormDefinition(raw).questions[0].options).toEqual(['A', 'B']);
  });

  it('vacía las opciones en tipos que no las usan', () => {
    const raw = validRaw({
      questions: [
        { name: 'nombre', type: 'short_text', label: 'N', help_text: '', required: false, options: ['x', 'y'] },
      ],
    });
    expect(validateFormDefinition(raw).questions[0].options).toEqual([]);
  });

  it('acepta un formulario sin preguntas', () => {
    expect(validateFormDefinition(validRaw({ questions: [] })).questions).toEqual([]);
  });

  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['nombre vacío', { name: '  ' }, 'Form name is required'],
    ['título vacío', { header: { title: '', subtitle: '' } }, 'Header title is required'],
    ['page_size inválido', { page_size: 'a3' }, 'page_size must be'],
    ['más de 100 preguntas', { questions: Array.from({ length: 101 }, (_, i) => ({ name: `c${i}`, type: 'short_text', label: 'x', help_text: '', required: false, options: [] })) }, 'more than 100'],
  ];
  it.each(cases)('rechaza %s con 400', (_name, overrides, message) => {
    expect(() => validateFormDefinition(validRaw(overrides))).toThrow(ValidationError);
    expect(() => validateFormDefinition(validRaw(overrides))).toThrow(message);
  });

  it('rechaza nombre de campo inválido', () => {
    const raw = validRaw({
      questions: [{ name: '1malo', type: 'short_text', label: 'x', help_text: '', required: false, options: [] }],
    });
    expect(() => validateFormDefinition(raw)).toThrow(/Field name/);
  });

  it('rechaza nombres de campo duplicados', () => {
    const raw = validRaw({
      questions: [
        { name: 'campo', type: 'short_text', label: 'x', help_text: '', required: false, options: [] },
        { name: 'campo', type: 'short_text', label: 'y', help_text: '', required: false, options: [] },
      ],
    });
    expect(() => validateFormDefinition(raw)).toThrow(/unique internal name/);
  });

  it('rechaza radio/select con menos de dos opciones', () => {
    const raw = validRaw({
      questions: [{ name: 'prioridad', type: 'radio', label: 'x', help_text: '', required: false, options: ['solo'] }],
    });
    expect(() => validateFormDefinition(raw)).toThrow(/at least two options/);
  });

  it('rechaza opciones duplicadas', () => {
    const raw = validRaw({
      questions: [{ name: 'sucursal', type: 'select', label: 'x', help_text: '', required: false, options: ['A', 'A'] }],
    });
    expect(() => validateFormDefinition(raw)).toThrow(/duplicated options/);
  });

  it('rechaza un tipo de pregunta desconocido', () => {
    const raw = validRaw({
      questions: [{ name: 'p', type: 'signature', label: 'x', help_text: '', required: false, options: [] }],
    });
    expect(() => validateFormDefinition(raw)).toThrow(/invalid type/);
  });

  it('rechaza un body que no es objeto', () => {
    expect(() => validateFormDefinition(null)).toThrow(/Form definition is required/);
  });
});
