import axios from 'axios';

export function setAcceptLanguageHeader(value: string): void {
  axios.defaults.headers.common['Accept-Language'] = value;
}

export function setTokenHeader(token: string | undefined) {
  if (token === undefined) {
    delete axios.defaults.headers.common['Authorization'];
  } else {
    axios.defaults.headers.common['Authorization'] = 'Bearer ' + token;
  }
}

export function setTimezoneHeader(): void {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (timezone) {
    axios.defaults.headers.common['X-Timezone'] = timezone;
  }
}
