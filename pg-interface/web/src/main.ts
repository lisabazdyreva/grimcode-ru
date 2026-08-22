import { createApp } from 'vue';
import {
  ElAside,
  ElButton,
  ElConfigProvider,
  ElContainer,
  ElDialog,
  ElDropdown,
  ElDropdownItem,
  ElDropdownMenu,
  ElForm,
  ElFormItem,
  ElInput,
  ElLoading,
  ElMain,
  ElOption,
  ElPagination,
  ElPopover,
  ElRadioButton,
  ElRadioGroup,
  ElSelect,
  ElTable,
  ElTableColumn,
} from 'element-plus';
import 'element-plus/dist/index.css';
import 'element-plus/theme-chalk/dark/css-vars.css';

import App from './App.vue';
import { listenToPanel } from './theme';
import './styles.css';

/*
 * The components this screen uses, one by one rather than the whole library: registering all of
 * element-plus carries every component it has into the bundle, and this screen uses a fifth of them.
 */
const COMPONENTS = [
  ElAside,
  ElButton,
  ElConfigProvider,
  ElContainer,
  ElDialog,
  ElDropdown,
  ElDropdownItem,
  ElDropdownMenu,
  ElForm,
  ElFormItem,
  ElInput,
  ElMain,
  ElOption,
  ElPagination,
  ElPopover,
  ElRadioButton,
  ElRadioGroup,
  ElSelect,
  ElTable,
  ElTableColumn,
];

listenToPanel();

const app = createApp(App);
for (const component of COMPONENTS) app.component(component.name ?? '', component);
app.use(ElLoading);
app.mount('#app');
