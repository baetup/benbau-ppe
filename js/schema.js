// SharePoint list definitions. Every list also has the built-in "Title" column:
//   locations.Title = location name, products.Title = product name, personnel.Title = full name,
//   stock.Title = "productId|size|locationId", handouts/transfers.Title = product name.
// Column names are the SharePoint internal names — do not rename them in SharePoint.
export const LISTS = {
  locations: {
    title: 'PPE_Locations',
    columns: [
      { name: 'Active', type: 'boolean' },
    ],
  },
  products: {
    title: 'PPE_Products',
    columns: [
      { name: 'Brand', type: 'text' },
      { name: 'Sizes', type: 'text' },        // comma separated, e.g. "S, M, L, XL"
      { name: 'ImageUrl', type: 'text' },
      { name: 'Active', type: 'boolean' },
    ],
  },
  stock: {
    title: 'PPE_Stock',
    columns: [
      { name: 'ProductId', type: 'number', indexed: true },
      { name: 'Size', type: 'text' },
      { name: 'LocationId', type: 'number', indexed: true },
      { name: 'Quantity', type: 'number' },
    ],
  },
  personnel: {
    title: 'PPE_Personnel',
    columns: [
      { name: 'Email', type: 'text' },
      { name: 'Phone', type: 'text' },
      { name: 'Company', type: 'text' },
      { name: 'EmployeeNo', type: 'text' },
      { name: 'LocationId', type: 'number' },
      { name: 'LocationName', type: 'text' },
      { name: 'Active', type: 'boolean' },
    ],
  },
  handouts: {
    title: 'PPE_Handouts',
    columns: [
      { name: 'BatchId', type: 'text', indexed: true },
      { name: 'PersonnelId', type: 'number', indexed: true },
      { name: 'PersonnelName', type: 'text' },
      { name: 'ProductId', type: 'number', indexed: true },
      { name: 'Size', type: 'text' },
      { name: 'Quantity', type: 'number' },
      { name: 'LocationId', type: 'number' },
      { name: 'LocationName', type: 'text' },
      { name: 'Reason', type: 'text' },
      { name: 'Notes', type: 'note' },
      { name: 'HandoutDate', type: 'dateTime', indexed: true },
      { name: 'HandedOutBy', type: 'text' },
      { name: 'HandedOutByEmail', type: 'text' },
      { name: 'Signature', type: 'note' },     // PNG data URL
    ],
  },
  transfers: {
    title: 'PPE_Transfers',
    columns: [
      { name: 'ProductId', type: 'number' },
      { name: 'Size', type: 'text' },
      { name: 'Quantity', type: 'number' },
      { name: 'FromLocationId', type: 'number' },
      { name: 'FromLocationName', type: 'text' },
      { name: 'ToLocationId', type: 'number' },
      { name: 'ToLocationName', type: 'text' },
      { name: 'Reason', type: 'note' },
      { name: 'TransferDate', type: 'dateTime' },
      { name: 'TransferredBy', type: 'text' },
    ],
  },
};

export const REASONS = [
  'New Issue',
  'Replacement - Worn Out',
  'Replacement - Damaged',
  'Replacement - Lost',
  'Size Change',
  'Project Requirement',
  'Training',
  'Other',
];
