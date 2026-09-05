import type { DiagnosticCommand } from '../../shared/ai'

type Language = 'ru' | 'en'
type Entry = {
  en: string
  ru: string
  command: string
  detail?: 'service' | 'device' | 'directory'
  heavy?: boolean
}
const entries: Record<string, Entry> = {
  os: { en: 'Linux distribution', ru: 'Дистрибутив Linux', command: 'cat /etc/os-release' },
  uptime: { en: 'Uptime and load', ru: 'Время работы и нагрузка', command: 'uptime' },
  cores: { en: 'CPU count', ru: 'Число процессоров', command: 'nproc' },
  cpu: {
    en: 'CPU, swap and I/O samples',
    ru: 'Замеры CPU, swap и ожидания I/O',
    command: 'vmstat 1 5'
  },
  memory: { en: 'Available memory', ru: 'Доступная память', command: 'free -b' },
  processes: {
    en: 'Processes and resource use',
    ru: 'Процессы и потребление ресурсов',
    command: 'ps -eo pid,ppid,comm,pcpu,pmem,rss,stat --sort=-rss'
  },
  devices: {
    en: 'Disks and partitions',
    ru: 'Диски и разделы',
    command: 'lsblk -o NAME,TYPE,SIZE,FSTYPE,MOUNTPOINT,ROTA'
  },
  space: { en: 'Filesystem capacity', ru: 'Заполнение файловых систем', command: 'df -hT' },
  inodes: { en: 'Filesystem inodes', ru: 'Свободные inode', command: 'df -i' },
  mounts: {
    en: 'Mount options and read-only filesystems',
    ru: 'Параметры монтирования и read-only',
    command: 'findmnt -o TARGET,SOURCE,FSTYPE,OPTIONS'
  },
  disk_io: {
    en: 'Disk latency, queue and throughput',
    ru: 'Задержки, очередь и скорость дисков',
    command: 'iostat -xz 1 3'
  },
  services: {
    en: 'Failed services',
    ru: 'Сбойные сервисы',
    command: 'systemctl --failed --no-pager --plain'
  },
  kernel: {
    en: 'Recent kernel warnings and errors',
    ru: 'Свежие предупреждения и ошибки ядра',
    command: 'journalctl -k -p warning --since "1 hour ago" -n 120 --no-pager -o short-iso'
  },
  raid: { en: 'Linux software RAID', ru: 'Программный RAID Linux', command: 'cat /proc/mdstat' },
  pressure: { en: 'I/O pressure', ru: 'Давление I/O', command: 'cat /proc/pressure/io' },
  diskstats: {
    en: 'Disk counters (single snapshot)',
    ru: 'Счётчики дисков (один снимок)',
    command: 'cat /proc/diskstats'
  },
  meminfo: { en: 'Memory details', ru: 'Подробности памяти', command: 'cat /proc/meminfo' },
  cpu_processes: {
    en: 'Processes sorted by lifetime CPU',
    ru: 'Процессы по среднему CPU за время жизни',
    command: 'ps -eo pid,ppid,comm,pcpu,pmem,rss,stat --sort=-pcpu'
  },
  process_io: {
    en: 'I/O by process',
    ru: 'Дисковая нагрузка по процессам',
    command: 'pidstat -d 1 3'
  },
  deleted_files: {
    en: 'Deleted files still held open',
    ru: 'Удалённые, но открытые файлы',
    command: 'lsof -nP +L1',
    heavy: true
  },
  journal_size: {
    en: 'Journal disk usage',
    ru: 'Место, занятое журналом',
    command: 'journalctl --disk-usage'
  },
  sockets: {
    en: 'Listening network sockets',
    ru: 'Слушающие сетевые сокеты',
    command: 'ss -lntup'
  },
  service_status: {
    en: 'Service status',
    ru: 'Состояние сервиса',
    command:
      'systemctl show --no-pager -p Id -p ActiveState -p SubState -p Result -p NRestarts -p ExecMainStatus -p MainPID --',
    detail: 'service'
  },
  service_logs: {
    en: 'Recent service logs',
    ru: 'Свежие логи сервиса',
    command: 'journalctl --since "30 minutes ago" -n 160 --no-pager -o short-iso -u',
    detail: 'service'
  },
  smart: {
    en: 'SMART device health (no self-test)',
    ru: 'Здоровье SMART (без самотестирования)',
    command: 'smartctl -a',
    detail: 'device'
  },
  nvme: { en: 'NVMe health', ru: 'Здоровье NVMe', command: 'nvme smart-log', detail: 'device' },
  directory_size: {
    en: 'Directory sizes within one filesystem',
    ru: 'Размеры каталогов внутри одной файловой системы',
    command: 'du -x -h --max-depth=1 --',
    detail: 'directory',
    heavy: true
  },
  lvm: {
    en: 'LVM and thin pool usage',
    ru: 'LVM и заполнение thin pool',
    command: 'lvs --readonly -o lv_name,vg_name,lv_size,segtype,data_percent,metadata_percent'
  },
  zfs: { en: 'ZFS pool health', ru: 'Здоровье пулов ZFS', command: 'zpool status -x' }
}
export const BASE_TOOLS = [
  'os',
  'uptime',
  'cores',
  'cpu',
  'memory',
  'processes',
  'devices',
  'space',
  'inodes',
  'mounts',
  'disk_io',
  'services',
  'kernel',
  'raid'
]

export function diagnosticCommand(
  tool: string,
  parameter: unknown,
  language: Language
): DiagnosticCommand {
  const entry = Object.hasOwn(entries, tool) ? entries[tool] : undefined
  if (!entry) throw new Error('Unknown diagnostic tool')
  let suffix = ''
  if (entry.detail) {
    if (typeof parameter !== 'string' || parameter.length > 180)
      throw new Error('Invalid diagnostic parameter')
    const valid =
      entry.detail === 'service'
        ? /^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*\.service$/.test(parameter)
        : entry.detail === 'device'
          ? /^\/dev\/(?:sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+(?:n\d+)?|mmcblk\d+)$/.test(parameter)
          : /^\/(?:var|home|srv|opt|tmp|usr|mnt|media)(?:\/[a-zA-Z0-9_.-]+)*$/.test(parameter) &&
            !parameter.split('/').includes('..')
    if (!valid) throw new Error('Invalid diagnostic parameter')
    suffix = ` '${parameter}'`
  } else if (parameter !== undefined && parameter !== '')
    throw new Error('This tool takes no parameter')
  return {
    tool,
    parameter: entry.detail ? (parameter as string) : undefined,
    command: entry.command + suffix,
    title: entry[language],
    purpose: entry[language],
    timeoutMs: 15000,
    rights:
      language === 'ru'
        ? 'Права текущего SSH-пользователя; без sudo. Часть данных может быть недоступна.'
        : 'Current SSH user; no sudo. Some data may be unavailable.',
    impact: entry.heavy
      ? language === 'ru'
        ? 'Обход файлов/процессов может создать заметную нагрузку; ограничение 15 с.'
        : 'Scanning files/processes may cause noticeable load; limited to 15 s.'
      : language === 'ru'
        ? 'Короткая проверка чтения; до 15 с. Утилита может отсутствовать.'
        : 'Short read-only check; up to 15 s. Utility may be unavailable.'
  }
}
export function catalogDescription(): string {
  return Object.entries(entries)
    .map(([id, e]) => `${id}: ${e.en}${e.detail ? `; parameter: ${e.detail}` : '; no parameter'}`)
    .join('\n')
}
