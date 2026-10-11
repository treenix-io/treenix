import { createNativeBrahman } from './native-service';

/** Bind explicit Telegram defaults without interpreting deployment host ports as bot options. */
export default function createBrahmanModule() {
  return createNativeBrahman();
}
