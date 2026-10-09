import { registerType } from '#comp';
import { registerNativeAutostart } from './native';

class Autostart {}

registerType('autostart', Autostart, { security: 'user-capability' });
registerNativeAutostart();
