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

/** Sección válida; los tests la mutan para probar cada regla. */
function section(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Datos personales',
    columns: 2,
    page_break: false,
    questions: [
      { name: 'nombre', type: 'short_text', label: 'Nombre', help_text: '', required: false, options: [], column_span: 1 },
      { name: 'apellido', type: 'short_text', label: 'Apellido', help_text: '', required: false, options: [], column_span: 1 },
    ],
    ...overrides,
  };
}

function withSections(...sections: Record<string, unknown>[]): Record<string, unknown> {
  const raw = validRaw({ sections });
  delete raw.questions;
  return raw;
}

describe('validateFormDefinition · secciones y columnas', () => {
  it('envuelve un payload sin secciones en una sección implícita', () => {
    const def = validateFormDefinition(validRaw());
    expect(def.sections).toHaveLength(1);
    expect(def.sections[0]).toMatchObject({ title: '', columns: 1, page_break: false });
    expect(def.sections[0].questions).toHaveLength(2);
    expect(def.sections[0].questions[0].column_span).toBe(1);
  });

  // `generateForm` revalida el payload ya guardado en la BD, así que validar dos
  // veces tiene que dar exactamente lo mismo o los formularios viejos se rompen.
  it('es idempotente: validar la salida devuelve la misma salida', () => {
    const once = validateFormDefinition(validRaw());
    expect(validateFormDefinition(once)).toEqual(once);

    const nested = validateFormDefinition(withSections(section()));
    expect(validateFormDefinition(nested)).toEqual(nested);
  });

  // Los `return` son whitelists que reconstruyen el objeto campo a campo: una
  // clave nueva que no se añada ahí se descarta en silencio y nunca llega al
  // worker. Este test es el que atrapa ese fallo.
  it('conserva sections y column_span (no los descarta la whitelist)', () => {
    const def = validateFormDefinition(withSections(
      section({ title: 'Notas', columns: 2, page_break: true, questions: [
        { name: 'notas', type: 'long_text', label: 'Notas', help_text: '', required: false, options: [], column_span: 2 },
      ] }),
    ));
    expect(def.sections[0].title).toBe('Notas');
    expect(def.sections[0].columns).toBe(2);
    expect(def.sections[0].page_break).toBe(true);
    expect(def.sections[0].questions[0].column_span).toBe(2);
  });

  it('si vienen sections, el questions de entrada se ignora', () => {
    const raw = validRaw({ sections: [section()] });
    // `questions` de validRaw() trae 'nombre' y 'prioridad'; sections manda.
    const def = validateFormDefinition(raw);
    expect(def.questions.map((q) => q.name)).toEqual(['nombre', 'apellido']);
  });

  it('el espejo questions aplana las secciones en orden', () => {
    const def = validateFormDefinition(withSections(
      section({ questions: [{ name: 'campo_a', type: 'short_text', label: 'A', help_text: '', required: false, options: [] }] }),
      section({ questions: [{ name: 'campo_b', type: 'short_text', label: 'B', help_text: '', required: false, options: [] }] }),
    ));
    expect(def.questions.map((q) => q.name)).toEqual(['campo_a', 'campo_b']);
  });

  it('columns y column_span ausentes caen en 1', () => {
    const def = validateFormDefinition(withSections(
      section({ columns: undefined, questions: [
        { name: 'solo', type: 'short_text', label: 'S', help_text: '', required: false, options: [] },
      ] }),
    ));
    expect(def.sections[0].columns).toBe(1);
    expect(def.sections[0].questions[0].column_span).toBe(1);
  });

  it('acepta columns como string numérico', () => {
    expect(validateFormDefinition(withSections(section({ columns: '3' }))).sections[0].columns).toBe(3);
  });

  it('rechaza nombres duplicados en secciones distintas (unicidad global)', () => {
    const raw = withSections(
      section({ questions: [{ name: 'campo', type: 'short_text', label: 'A', help_text: '', required: false, options: [] }] }),
      section({ questions: [{ name: 'campo', type: 'short_text', label: 'B', help_text: '', required: false, options: [] }] }),
    );
    expect(() => validateFormDefinition(raw)).toThrow(/unique internal name/);
  });

  it('numera los errores de forma global a través de secciones', () => {
    const raw = withSections(
      section(),
      section({ questions: [{ name: '', type: 'nope', label: 'x', help_text: '', required: false, options: [] }] }),
    );
    // Las 2 preguntas de la primera sección ya se contaron: esta es la 3ª.
    expect(() => validateFormDefinition(raw)).toThrow(/Question 3 has an invalid type/);
  });

  const sectionCases: Array<[string, Record<string, unknown>, string]> = [
    ['columns 0', section({ columns: 0 }), 'between 1 and 3 columns'],
    ['columns 4', section({ columns: 4 }), 'between 1 and 3 columns'],
    ['columns no numérico', section({ columns: 'x' }), 'between 1 and 3 columns'],
    ['columns decimal', section({ columns: 2.5 }), 'between 1 and 3 columns'],
    ['título de sección > 120', section({ title: 'x'.repeat(121) }), 'at most 120 characters'],
  ];
  it.each(sectionCases)('rechaza %s con 400', (_name, sec, message) => {
    expect(() => validateFormDefinition(withSections(sec))).toThrow(ValidationError);
    expect(() => validateFormDefinition(withSections(sec))).toThrow(message);
  });

  it('rechaza column_span mayor que las columnas de su sección', () => {
    const raw = withSections(section({ columns: 2, questions: [
      { name: 'ancho', type: 'short_text', label: 'X', help_text: '', required: false, options: [], column_span: 3 },
    ] }));
    expect(() => validateFormDefinition(raw)).toThrow(/spans 3 columns but its section only has 2/);
  });

  it('rechaza column_span inválido', () => {
    const raw = withSections(section({ questions: [
      { name: 'malo', type: 'short_text', label: 'X', help_text: '', required: false, options: [], column_span: 0 },
    ] }));
    expect(() => validateFormDefinition(raw)).toThrow(/invalid column_span/);
  });

  it('rechaza más de 20 secciones', () => {
    const many = Array.from({ length: 21 }, () => section({ questions: [] }));
    expect(() => validateFormDefinition(withSections(...many))).toThrow(/more than 20 sections/);
  });

  it('rechaza más de 100 preguntas repartidas entre secciones', () => {
    const make = (prefix: string) => section({
      questions: Array.from({ length: 51 }, (_, i) => ({
        name: `${prefix}${i}`, type: 'short_text', label: 'x', help_text: '', required: false, options: [],
      })),
    });
    expect(() => validateFormDefinition(withSections(make('a'), make('b')))).toThrow(/more than 100/);
  });

  it('acepta un formulario con secciones vacías', () => {
    const def = validateFormDefinition(withSections(section({ questions: [] })));
    expect(def.questions).toEqual([]);
    expect(def.sections).toHaveLength(1);
  });
});

// PNG de 1x1 real: los magic bytes se comprueban sobre el contenido decodificado,
// así que no vale una cadena base64 cualquiera.
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const JPEG_1PX = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

describe('validateFormDefinition · logo e iconos', () => {
  it('acepta un logo PNG en el encabezado', () => {
    const raw = validRaw({ header: { title: 'X', subtitle: '', logo: PNG_1PX } });
    expect(validateFormDefinition(raw).header.logo).toBe(PNG_1PX);
  });

  it('acepta un icono JPEG en una pregunta', () => {
    const raw = withSections(section({ questions: [
      { name: 'campo', type: 'short_text', label: 'X', help_text: '', required: false, options: [], icon: JPEG_1PX },
    ] }));
    expect(validateFormDefinition(raw).sections[0].questions[0].icon).toBe(JPEG_1PX);
  });

  it('sin logo ni icono quedan en cadena vacía', () => {
    const def = validateFormDefinition(validRaw());
    expect(def.header.logo).toBe('');
    expect(def.questions[0].icon).toBe('');
  });

  // El espejo solo lo consume un worker antiguo, que no dibuja iconos: duplicar
  // los data URI doblaría el payload y cada operation_params.
  it('el espejo plano NO lleva los iconos', () => {
    const raw = withSections(section({ questions: [
      { name: 'campo', type: 'short_text', label: 'X', help_text: '', required: false, options: [], icon: PNG_1PX },
    ] }));
    const def = validateFormDefinition(raw);
    expect(def.sections[0].questions[0].icon).toBe(PNG_1PX);
    expect(def.questions[0].icon).toBe('');
  });

  it('sigue siendo idempotente con imágenes', () => {
    const raw = validRaw({ header: { title: 'X', subtitle: '', logo: PNG_1PX } });
    const once = validateFormDefinition(raw);
    expect(validateFormDefinition(once)).toEqual(once);
  });

  it('rechaza un data URI que no es imagen', () => {
    const raw = validRaw({ header: { title: 'X', subtitle: '', logo: 'data:text/html;base64,PGh0bWw+' } });
    expect(() => validateFormDefinition(raw)).toThrow(/must be a PNG or JPEG/);
  });

  it('rechaza una URL en vez de un data URI', () => {
    const raw = validRaw({ header: { title: 'X', subtitle: '', logo: 'https://ejemplo.com/logo.png' } });
    expect(() => validateFormDefinition(raw)).toThrow(/must be a PNG or JPEG/);
  });

  // Declarar image/png no basta: se miran los magic bytes del contenido.
  it('rechaza contenido que no coincide con el tipo declarado', () => {
    const falso = 'data:image/png;base64,' + Buffer.from('esto no es un png').toString('base64');
    const raw = validRaw({ header: { title: 'X', subtitle: '', logo: falso } });
    expect(() => validateFormDefinition(raw)).toThrow(/not a valid PNG or JPEG/);
  });

  it('rechaza un JPEG disfrazado de PNG', () => {
    const disfrazado = JPEG_1PX.replace('image/jpeg', 'image/png');
    const raw = validRaw({ header: { title: 'X', subtitle: '', logo: disfrazado } });
    expect(() => validateFormDefinition(raw)).toThrow(/does not match its declared type/);
  });

  it('rechaza un logo demasiado grande', () => {
    const enorme = 'data:image/png;base64,' + Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(500 * 1024),
    ]).toString('base64');
    const raw = validRaw({ header: { title: 'X', subtitle: '', logo: enorme } });
    expect(() => validateFormDefinition(raw)).toThrow(/too large/);
  });

  it('rechaza un icono demasiado grande', () => {
    const enorme = 'data:image/png;base64,' + Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(200 * 1024),
    ]).toString('base64');
    const raw = withSections(section({ questions: [
      { name: 'campo', type: 'short_text', label: 'X', help_text: '', required: false, options: [], icon: enorme },
    ] }));
    expect(() => validateFormDefinition(raw)).toThrow(/too large/);
  });
});
