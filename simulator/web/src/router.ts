// router.ts: two pages, two paths. The simulator's server answers every unknown
// path with index.html, so /3d works on reload and as a shared link.
import { useCallback, useEffect, useState } from 'react';

export type Route = 'panels' | 'playground' | 'drive';

const PATHS: Record<Route, string> = { panels: '/', playground: '/3d', drive: '/drive' };

function current(): Route {
  const path = location.pathname.replace(/\/+$/, '');
  return (Object.keys(PATHS) as Route[]).find((r) => r !== 'panels' && PATHS[r] === path) ?? 'panels';
}

export function useRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(current);
  useEffect(() => {
    const onPop = () => setRoute(current());
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((next: Route) => {
    if (next === current()) return;
    history.pushState(null, '', PATHS[next]);
    setRoute(next);
  }, []);
  return [route, navigate];
}

export function hrefOf(route: Route): string {
  return PATHS[route];
}
