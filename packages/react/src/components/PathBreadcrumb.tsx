import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '#components/ui/breadcrumb';

export function PathBreadcrumb({ path, onSelect }: { path: string; onSelect: (p: string) => void }) {
  const parts = path.split('/').filter(Boolean);
  const crumbs: { label: string; path: string }[] = [{ label: 'root', path: '/' }];
  let cur = '';
  for (const p of parts) {
    cur += '/' + p;
    crumbs.push({ label: p, path: cur });
  }
  const last = crumbs.length - 1;

  return (
    <Breadcrumb className="mb-2 text-xs">
      <BreadcrumbList className="text-xs gap-1 sm:gap-1">
        {crumbs.map((c, i) => (
          <span key={c.path} className="contents">
            {i > 0 && <BreadcrumbSeparator className="[&>svg]:size-3" />}
            <BreadcrumbItem>
              {i === last
                ? <BreadcrumbPage>{c.label}</BreadcrumbPage>
                : <BreadcrumbLink className="cursor-pointer" onClick={() => onSelect(c.path)}>{c.label}</BreadcrumbLink>}
            </BreadcrumbItem>
          </span>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
