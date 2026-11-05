import './styles.css';
import './shell/menu-refinement.css';
import './shell/workbench-refinement.css';
import { initI18n } from './common/i18n';
import { boot } from './shell/app';

initI18n();
void boot();
