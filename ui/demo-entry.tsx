import { createRoot } from 'react-dom/client';
import App from './App';
import { createLocalApi } from './localApi';
createRoot(document.getElementById('root')!).render(<App api={createLocalApi()} />);
