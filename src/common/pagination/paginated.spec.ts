import { listPaginated } from './paginated';

const present = (r: { id: string; n: number }) => ({ id: r.id, doubled: r.n * 2 });

describe('listPaginated', () => {
  it('uses the page branch when q is absent and applies the default page size', async () => {
    const page = jest.fn().mockResolvedValue({ rows: [{ id: 'a', n: 1 }], total: 1 });
    const search = jest.fn();
    const res = await listPaginated({ present, page, search, hydrate: jest.fn() });
    expect(res).toEqual({ data: [{ id: 'a', doubled: 2 }], total: 1, limit: 50, offset: 0 });
    expect(page).toHaveBeenCalledWith({ limit: 50, offset: 0 });
    expect(search).not.toHaveBeenCalled();
  });

  it('uses the search branch when q meets MIN_QUERY_LENGTH and re-orders rows to id rank', async () => {
    const search = jest.fn().mockResolvedValue({ ids: ['b', 'a'], total: 2 });
    const hydrate = jest.fn().mockResolvedValue([{ id: 'a', n: 1 }, { id: 'b', n: 2 }]);
    const page = jest.fn();
    const res = await listPaginated({ q: 'foo', limit: 10, offset: 5, present, search, hydrate, page });
    expect(res.data).toEqual([{ id: 'b', doubled: 4 }, { id: 'a', doubled: 2 }]);
    expect(res).toMatchObject({ total: 2, limit: 10, offset: 5 });
    expect(page).not.toHaveBeenCalled();
  });

  it('drops ids hydrate cannot resolve (concurrent soft-delete)', async () => {
    const res = await listPaginated({
      q: 'foo', present,
      search: jest.fn().mockResolvedValue({ ids: ['a', 'gone'], total: 2 }),
      hydrate: jest.fn().mockResolvedValue([{ id: 'a', n: 1 }]),
      page: jest.fn(),
    });
    expect(res.data).toEqual([{ id: 'a', doubled: 2 }]);
  });

  it('skips hydrate when search returns no ids', async () => {
    const hydrate = jest.fn();
    const res = await listPaginated({
      q: 'zzz', present, hydrate,
      search: jest.fn().mockResolvedValue({ ids: [], total: 0 }),
      page: jest.fn(),
    });
    expect(res.data).toEqual([]);
    expect(hydrate).not.toHaveBeenCalled();
  });

  it('treats a sub-MIN_QUERY_LENGTH term (1 char) as no search', async () => {
    const page = jest.fn().mockResolvedValue({ rows: [], total: 0 });
    const search = jest.fn();
    await listPaginated({ q: 'a', present, search, hydrate: jest.fn(), page });
    expect(page).toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it('uses the page branch when no search closure is provided (search-less endpoint)', async () => {
    const page = jest.fn().mockResolvedValue({ rows: [{ id: 'a', n: 2 }], total: 1 });
    const res = await listPaginated({ q: 'anything', present, page });
    expect(res.data).toEqual([{ id: 'a', doubled: 4 }]);
    expect(page).toHaveBeenCalled();
  });
});
