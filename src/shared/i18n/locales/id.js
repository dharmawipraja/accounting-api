/**
 * Indonesian (Bahasa Indonesia) Translations
 * All user-facing messages for the accounting API
 */

export const id = {
  // General Messages
  general: {
    success: 'Berhasil',
    error: 'Terjadi kesalahan',
    operationSuccessful: 'Operasi berhasil',
    dataRetrievedSuccessfully: 'Data berhasil diambil'
  },

  // HTTP Status Messages
  http: {
    unauthorized: 'Diperlukan autentikasi',
    forbidden: 'Izin tidak mencukupi',
    notFound: 'Sumber daya tidak ditemukan',
    alreadyExists: 'Sumber daya sudah ada',
    validationFailed: 'Validasi gagal',
    databaseError: 'Operasi database gagal',
    internalError: 'Kesalahan server internal',
    conflict: 'Konflik',
    badRequest: 'Permintaan tidak valid',
    payloadTooLarge: 'Ukuran payload terlalu besar',
    requestBodyTooLarge: 'Ukuran body permintaan terlalu besar',
    parseError: 'JSON tidak valid dalam body permintaan'
  },

  // Authentication Messages
  auth: {
    missingToken: 'Token autentikasi diperlukan',
    invalidToken: 'Token autentikasi tidak valid',
    tokenExpired: 'Token autentikasi telah kedaluwarsa',
    userNotFound: 'Pengguna tidak ditemukan',
    userInactive: 'Akun pengguna tidak aktif',
    notAuthenticated: 'Diperlukan autentikasi',
    insufficientPermissions: 'Izin tidak mencukupi untuk mengakses sumber daya ini',
    invalidCredentials: 'Kredensial tidak valid',
    logoutSuccessful: 'Logout berhasil',
    currentPasswordIncorrect: 'Kata sandi saat ini salah',
    authenticationFailed: 'Autentikasi gagal',
    profileRetrievedSuccessfully: 'Profil berhasil diambil',
    tokenRefreshedSuccessfully: 'Token berhasil disegarkan',
    loginSuccessful: 'Login berhasil',
    pleaseRemoveTokenFromClient: 'Silakan hapus token dari klien Anda'
  },

  // CRUD Operation Messages
  crud: {
    created: 'Sumber daya berhasil dibuat',
    updated: 'Sumber daya berhasil diperbarui',
    deleted: 'Sumber daya berhasil dihapus',
    retrieved: 'Sumber daya berhasil diambil',
    resourceCreatedSuccessfully: 'Sumber daya berhasil dibuat',
    resourceUpdatedSuccessfully: 'Sumber daya berhasil diperbarui',
    resourceDeletedSuccessfully: 'Sumber daya berhasil dihapus',
    resourceRetrievedSuccessfully: 'Sumber daya berhasil diambil'
  },

  // User Management Messages
  users: {
    usernameAlreadyExists: 'Nama pengguna sudah ada',
    userNotFound: 'Pengguna tidak ditemukan',
    userCreatedSuccessfully: 'Pengguna berhasil dibuat',
    userUpdatedSuccessfully: 'Pengguna berhasil diperbarui',
    userDeletedSuccessfully: 'Pengguna berhasil dihapus',
    passwordChangedSuccessfully: 'Kata sandi berhasil diubah'
  },

  // Account Management Messages
  accounts: {
    accountsNotFound: 'Akun tidak ditemukan',
    accountCreatedSuccessfully: 'Akun berhasil dibuat',
    accountUpdatedSuccessfully: 'Akun berhasil diperbarui',
    accountDeletedSuccessfully: 'Akun berhasil dihapus',
    accountRetrievedSuccessfully: 'Akun berhasil diambil',
    cannotDeleteAccount: 'Tidak dapat menghapus akun'
  },

  // Ledger Management Messages
  ledgers: {
    ledgerNotFound: 'Entri buku besar tidak ditemukan',
    cannotUpdatePostedLedger: 'Tidak dapat memperbarui entri buku besar yang sudah diposting',
    cannotDeletePostedLedger: 'Tidak dapat menghapus entri buku besar yang sudah diposting',
    cannotDeletePostedLedgerEntries: 'Tidak dapat menghapus entri buku besar yang sudah diposting',
    ledgerCreatedSuccessfully: 'Entri buku besar berhasil dibuat',
    ledgerUpdatedSuccessfully: 'Entri buku besar berhasil diperbarui',
    ledgerDeletedSuccessfully: 'Entri buku besar berhasil dihapus',
    noLedgersFoundForDate: 'Tidak ada buku besar yang ditemukan untuk tanggal yang ditentukan',
    invalidDateFormat: 'Format tanggal tidak valid',
    ledgerEntriesCreatedSuccessfully: 'Entri buku besar berhasil dibuat',
    ledgerEntryRetrievedSuccessfully: 'Entri buku besar berhasil diambil',
    ledgerEntryUpdatedSuccessfully: 'Entri buku besar berhasil diperbarui',
    ledgerEntryDeletedSuccessfully: 'Entri buku besar berhasil dihapus',
    ledgersRetrievedSuccessfully: 'Buku besar berhasil diambil'
  },

  // Journal Ledger Management Messages
  journalLedgers: {
    journalLedgerNotFound: 'Entri jurnal buku besar tidak ditemukan',
    journalLedgerCreatedSuccessfully: 'Entri jurnal buku besar berhasil dibuat',
    journalLedgerUpdatedSuccessfully: 'Entri jurnal buku besar berhasil diperbarui',
    journalLedgerDeletedSuccessfully: 'Entri jurnal buku besar berhasil dihapus',
    journalLedgerEntryRetrievedSuccessfully: 'Entri jurnal buku besar berhasil diambil',
    journalLedgersRetrievedSuccessfully: 'Jurnal buku besar berhasil diambil'
  },

  // Posting Messages
  posting: {
    noPendingLedgersFound:
      'Tidak ada buku besar tertunda yang ditemukan untuk tanggal yang ditentukan',
    ledgersAlreadyPosted:
      'Buku besar untuk tanggal {date} sudah diposting. Tidak dapat memposting tanggal yang sama dua kali.',
    postingSuccessful: 'Posting berhasil',
    ledgersPostedSuccessfully: 'Buku besar berhasil diposting untuk tanggal {date}',
    shuCalculatedSuccessful: 'Berhasil {action} Sisa Hasil Usaha untuk tahun {year}',
    shuUpdated: 'memperbarui',
    shuCalculated: 'menghitung dan memposting',
    alreadyPosted: 'Sudah diposting untuk tanggal ini',
    noPendingJournalLedgers:
      'Tidak ada entri jurnal buku besar tertunda yang ditemukan hingga tanggal yang ditentukan',
    noPostedLedgersFound:
      'Tidak ada buku besar yang diposting ditemukan untuk tanggal yang ditentukan',
    noLabaRugiAccounts: 'Tidak ada akun LABA_RUGI yang ditemukan dalam sistem',
    invalidShuAmount: 'Jumlah sisaHasilUsaha harus berupa angka yang valid',
    shuAccountNotFound: 'Detail Akun dengan nomor 3203 (SHU) tidak ditemukan',
    noAccountDetailsFound: 'Tidak ada detail akun yang ditemukan dalam sistem',
    balancePostedSuccessfully: 'Saldo berhasil diposting untuk {count} entri jurnal hingga {date}',
    ledgerUnpostedSuccessfully:
      'Berhasil membatalkan posting {count} entri buku besar untuk {date}',
    balanceUnpostedSuccessfully:
      'Berhasil membatalkan posting saldo untuk {count} entri jurnal untuk {date}',
    neracaAkhirPostedSuccessfully:
      'Berhasil memposting neraca akhir untuk {generalCount} akun umum dari {detailCount} akun detail pada {date}',
    accountDetailNotFound: 'Detail Akun dengan nomor {accountNumber} tidak ditemukan'
  },

  // Validation Messages
  validation: {
    required: '{field} wajib diisi',
    invalidFormat: 'Format {field} tidak valid',
    minLength: '{field} minimal {min} karakter',
    maxLength: '{field} maksimal {max} karakter',
    invalidEmail: 'Format email tidak valid',
    invalidPassword: 'Kata sandi harus minimal 6 karakter',
    invalidUsername: 'Nama pengguna harus minimal 3 karakter',
    invalidAmount: 'Jumlah harus berupa angka positif',
    invalidDate: 'Format tanggal tidak valid',
    invalidAccountNumber: 'Nomor akun tidak valid',
    invalidAccountCategory: 'Kategori akun tidak valid',
    invalidTransactionType: 'Jenis transaksi tidak valid',
    invalidUserRole: 'Peran pengguna tidak valid',
    invalidUserStatus: 'Status pengguna tidak valid'
  },

  // Rate Limiting Messages
  rateLimit: {
    tooManyRequests: 'Terlalu banyak permintaan dari IP ini, silakan coba lagi nanti.'
  },

  // API Information
  api: {
    welcome: 'API Akuntansi v1',
    description: 'Selamat datang di API Akuntansi untuk sistem koperasi'
  },

  // Account Categories (translated)
  accountCategories: {
    ASSET: 'Aset',
    HUTANG: 'Hutang',
    MODAL: 'Modal',
    PENDAPATAN: 'Pendapatan',
    BIAYA: 'Biaya'
  },

  // User Roles (translated)
  userRoles: {
    NASABAH: 'Nasabah',
    KASIR: 'Kasir',
    KOLEKTOR: 'Kolektor',
    MANAJER: 'Manajer',
    ADMIN: 'Admin',
    AKUNTAN: 'Akuntan'
  },

  // User Status (translated)
  userStatus: {
    ACTIVE: 'Aktif',
    INACTIVE: 'Tidak Aktif'
  },

  // Transaction Types (translated)
  transactionTypes: {
    DEBIT: 'Debit',
    CREDIT: 'Kredit'
  },

  // Ledger Types (translated)
  ledgerTypes: {
    KAS: 'Kas',
    KAS_MASUK: 'Kas Masuk',
    KAS_KELUAR: 'Kas Keluar'
  },

  // Posting Status (translated)
  postingStatus: {
    PENDING: 'Tertunda',
    POSTED: 'Diposting'
  },

  // Report Types (translated)
  reportTypes: {
    NERACA: 'Neraca',
    LABA_RUGI: 'Laba Rugi'
  },

  // Error Types (translated)
  errorTypes: {
    ValidationError: 'Kesalahan Validasi',
    AuthenticationError: 'Kesalahan Autentikasi',
    AuthorizationError: 'Kesalahan Otorisasi',
    NotFoundError: 'Kesalahan Tidak Ditemukan',
    ConflictError: 'Kesalahan Konflik',
    BusinessLogicError: 'Kesalahan Logika Bisnis',
    InternalServerError: 'Kesalahan Server Internal',
    DatabaseError: 'Kesalahan Database',
    PayloadTooLarge: 'Payload Terlalu Besar',
    ParseError: 'Kesalahan Parse'
  }
};
