'use client';
import App from '../ui/App';
import { httpApi } from '../ui/httpApi';
export default function Page() { return <App api={httpApi} />; }
