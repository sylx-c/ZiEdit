import './styles.css';
import { initI18n } from './common/i18n';
import { boot } from './shell/app';

initI18n();
void boot();
