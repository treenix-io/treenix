// Example mod: Ticker — price feed with real-time updates
import { registerType } from '#comp';

/** Price feed config — trading symbol and polling interval */
export class TickerConfig {
  symbol = 'BTC';
  intervalSec = 10;

  /** @description Update symbol and polling interval */
  configure(data: { symbol: string; intervalSec: number }) {
    this.symbol = data.symbol;
    this.intervalSec = data.intervalSec;
  }
}
registerType('ticker.config', TickerConfig);

/** Latest price snapshot — current price and timestamp */
export class TickerPrice {
  price = 0;
  ts = 0;
}
registerType('ticker.price', TickerPrice);
