import 'reflect-metadata';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { enablePatches } from 'immer';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './load-client';
import './style.css';

enablePatches();

const queryClient = new QueryClient();

const root = document.getElementById('root');
if (!root) throw new Error('No #root element');
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
