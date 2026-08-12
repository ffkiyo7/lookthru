import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppShell } from './components/AppShell';
import { PrefsProvider } from './lib/prefs';
import { Portfolio } from './routes/Portfolio';
import { FundDetail } from './routes/FundDetail';
import { Search } from './routes/Search';
import { XRay } from './routes/XRay';
import { Settings } from './routes/Settings';
import { Probe } from './routes/Probe';
import { RequireSession } from './routes/Auth';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 上游抖动是常态，但也不该无限重试打爆额度
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <PrefsProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="search" element={<Search />} />
            </Route>
            <Route element={<RequireSession />}>
              <Route element={<AppShell />}>
                <Route index element={<Portfolio />} />
                <Route path="xray" element={<XRay />} />
                <Route path="settings" element={<Settings />} />
              </Route>
            </Route>
            <Route path="/fund/:code" element={<FundDetail />} />
            {/* P0 判定面板，部署后用它看 24h 出口通过率 */}
            <Route path="/probe" element={<Probe />} />
          </Routes>
        </BrowserRouter>
      </PrefsProvider>
    </QueryClientProvider>
  );
}
