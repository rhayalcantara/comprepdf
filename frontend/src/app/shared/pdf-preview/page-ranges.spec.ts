import { parsePageSpec, formatPageSpec, rangesToSpec, chunkIntoRanges, isValidRange } from './page-ranges';

describe('page-ranges', () => {
  describe('parsePageSpec', () => {
    it('parsea páginas y rangos', () => {
      expect(parsePageSpec('1-3,5')).toEqual([1, 2, 3, 5]);
    });

    it('ignora tokens inválidos y espacios', () => {
      expect(parsePageSpec(' 2 , x, 4 - 5 ,, -3')).toEqual([2, 4, 5]);
    });

    it('acepta rangos invertidos', () => {
      expect(parsePageSpec('5-3')).toEqual([3, 4, 5]);
    });

    it('deduplica y ordena', () => {
      expect(parsePageSpec('5,1-3,2')).toEqual([1, 2, 3, 5]);
    });

    it('recorta a pageCount', () => {
      expect(parsePageSpec('1-3,7,9', 7)).toEqual([1, 2, 3, 7]);
    });

    it('devuelve vacío para entrada vacía', () => {
      expect(parsePageSpec('')).toEqual([]);
    });
  });

  describe('formatPageSpec', () => {
    it('colapsa consecutivos', () => {
      expect(formatPageSpec([1, 2, 3, 5])).toBe('1-3,5');
    });

    it('ordena y deduplica antes de colapsar', () => {
      expect(formatPageSpec([5, 1, 3, 2, 5])).toBe('1-3,5');
    });

    it('página suelta sin guion', () => {
      expect(formatPageSpec([4])).toBe('4');
    });

    it('vacío → cadena vacía', () => {
      expect(formatPageSpec([])).toBe('');
    });

    it('roundtrip con parsePageSpec', () => {
      expect(formatPageSpec(parsePageSpec('1-3,5,8-10'))).toBe('1-3,5,8-10');
    });
  });

  describe('rangesToSpec', () => {
    it('serializa rangos y páginas sueltas en orden', () => {
      expect(rangesToSpec([{ from: 5, to: 7 }, { from: 2, to: 2 }])).toBe('5-7,2');
    });
  });

  describe('chunkIntoRanges', () => {
    it('divide con resto', () => {
      expect(chunkIntoRanges(10, 3)).toEqual([
        { from: 1, to: 3 }, { from: 4, to: 6 }, { from: 7, to: 9 }, { from: 10, to: 10 },
      ]);
    });

    it('size 1 = una página por rango', () => {
      expect(chunkIntoRanges(3, 1)).toEqual([
        { from: 1, to: 1 }, { from: 2, to: 2 }, { from: 3, to: 3 },
      ]);
    });

    it('size mayor que el total = un solo rango', () => {
      expect(chunkIntoRanges(4, 99)).toEqual([{ from: 1, to: 4 }]);
    });

    it('entradas inválidas → vacío', () => {
      expect(chunkIntoRanges(0, 3)).toEqual([]);
      expect(chunkIntoRanges(5, 0)).toEqual([]);
    });
  });

  describe('isValidRange', () => {
    it('valida contra pageCount', () => {
      expect(isValidRange({ from: 1, to: 5 }, 5)).toBeTrue();
      expect(isValidRange({ from: 1, to: 6 }, 5)).toBeFalse();
      expect(isValidRange({ from: 3, to: 2 }, 5)).toBeFalse();
      expect(isValidRange({ from: 0, to: 2 }, 5)).toBeFalse();
    });

    it('con pageCount desconocido (0) solo exige from<=to y >=1', () => {
      expect(isValidRange({ from: 2, to: 99 }, 0)).toBeTrue();
      expect(isValidRange({ from: 3, to: 1 }, 0)).toBeFalse();
    });
  });
});
