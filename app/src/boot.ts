import {hasCachedConfig, loadAppConfig} from './engine/contract';
import {lazy} from './shared/lazy';

const main = () => lazy(() => import('./main'), 'the app');

if (hasCachedConfig()) {
  void loadAppConfig();
  void main();
} else {
  void loadAppConfig().then(main);
}
