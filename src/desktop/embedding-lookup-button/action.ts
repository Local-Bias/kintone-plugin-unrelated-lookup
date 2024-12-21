import { PLUGIN_NAME } from '@/lib/constants';
import { isProd } from '@/lib/global';
import {
  getQueryValue,
  isMultipleSearchableFieldType,
  isTextSearchableFieldType,
  someFieldValue,
} from '@/lib/kintone-api';
import { store } from '@/lib/store';
import { PluginCondition } from '@/schema/plugin-config';
import {
  getCurrentRecord,
  getFieldValueAsString,
  getRecords,
  kintoneAPI,
  setCurrentRecord,
} from '@konomi-app/kintone-utilities';
import { OptionsObject, SnackbarKey, SnackbarMessage } from 'notistack';
import { SetterOrUpdater } from 'recoil';
import { clone } from 'remeda';
import { convertFieldValueByTargetType, getDstField } from '../common';
import { isAlreadyLookupedAtom, valueAtLookupAtom } from '../states';
import { AttachmentProps } from './app';
import { alreadyCacheAtom } from './states';
import { srcAppPropertiesAtom } from './states/kintone';
import { srcAllHandledRecordsAtom } from './states/records';

type CurrentKintoneField = kintoneAPI.Field & {
  lookup?: boolean | 'CLEAR';
  error?: null | string;
};

type EnqueueSnackbar = (
  message: SnackbarMessage,
  options?: OptionsObject | undefined
) => SnackbarKey;

export const lookup = async (params: {
  condition: PluginCondition;
  record: kintoneAPI.RecordData;
  attachmentProps: AttachmentProps;
  option?: {
    input: string;
    enqueueSnackbar: EnqueueSnackbar;
    setShown: SetterOrUpdater<boolean>;
  };
}): Promise<kintoneAPI.RecordData> => {
  const { attachmentProps, condition, record, option } = params;

  if (condition.type === 'subtable') {
    return record;
  }

  const dstField = getDstField({ condition, record, rowIndex: attachmentProps.rowIndex });
  if (!dstField) {
    throw new Error('ルックアップ先のフィールドが見つかりません');
  }

  const isAlreadyCached = store.get(alreadyCacheAtom(attachmentProps.conditionId));
  if (isAlreadyCached) {
    !isProd &&
      console.log(
        '♻ 全てのレコードがキャッシュ済みのため、キャッシュされたレコードから検索します'
      );

    const allRecords = store.get(srcAllHandledRecordsAtom(attachmentProps.conditionId));
    // 🚧 改修が必要
    // せっかく比較対象それぞれのフィールド情報を持っているので、値としてではなくフィールドタイプ毎に比較する方が望ましい
    // 例えば、ユーザーエンティティ同士であれば、ユーザーコードを比較する
    const filtered = allRecords.filter((r) => {
      const srcField = r.record[condition.srcField];
      if (!srcField) {
        return false;
      }
      return someFieldValue(srcField, getFieldValueAsString(dstField));
    });
    if (filtered.length === 1) {
      const applied = apply({
        condition,
        targetRecord: record,
        sourceRecord: filtered[0]!.record,
        attachmentProps,
        option,
      });
      return applied;
    }
    if (option?.setShown) {
      option.setShown(true);
    } else {
      if (filtered.length > 1) {
        throw new Error(
          '入力された値に一致するレコードが複数見つかりました。取得ボタンを押して選択してください'
        );
      }
      throw new Error('入力された値に一致するレコードが見つかりませんでした');
    }
    return record;
  }

  const app = condition.srcAppId;
  const additionalQuery = condition.filterQuery || '';
  const srcAppProperties = await store.get(srcAppPropertiesAtom(attachmentProps.conditionId));
  const srcField = srcAppProperties[condition.srcField];

  let query = '';
  if (dstField.value) {
    const queryValue = getQueryValue(dstField);

    if (isMultipleSearchableFieldType(srcField?.type)) {
      if (Array.isArray(queryValue)) {
        query = `${condition.srcField} in (${queryValue.join(',')})`;
      } else {
        query = `${condition.srcField} in (${queryValue})`;
      }
    } else {
      const operator = isTextSearchableFieldType(srcField?.type) ? 'like' : '=';
      if (Array.isArray(queryValue)) {
        query = `(${queryValue.map((v) => `${condition.srcField} ${operator} ${v}`).join(' or ')})`;
      } else {
        query = `${condition.srcField} ${operator} ${queryValue}`;
      }
    }

    if (additionalQuery) {
      query += ` and ${additionalQuery}`;
    }
  } else {
    if (additionalQuery) {
      query += additionalQuery;
    }
  }
  query += ' limit 2';

  !isProd && console.log(`[${PLUGIN_NAME}] 検索クエリ`, query);

  const fields = getLookupSrcFields(condition);

  const { records: lookupRecords } = await getRecords({
    app,
    query,
    fields,
    guestSpaceId: condition.isSrcAppGuestSpace ? (condition.srcSpaceId ?? undefined) : undefined,
    debug: !isProd,
  });

  if (lookupRecords.length !== 1) {
    if (!option?.setShown) {
      throw new Error('入力された値に一致するレコードが見つかりませんでした');
    }
    option.setShown(true);
    return record;
  }

  return apply({
    condition,
    targetRecord: record,
    attachmentProps,
    sourceRecord: lookupRecords[0]!,
    option,
  });
};

export const getLookupSrcFields = (condition: PluginCondition) => {
  const fields = [
    ...new Set(
      [
        condition.copies.map(({ from }) => from),
        condition.insubtableCopies.map(({ from }) => from),
        condition.displayFields.map((field) => field.fieldCode),
        condition.srcField,
        condition.dynamicConditions.map((condition) => condition.srcAppFieldCode),
        condition.sortCriteria.map((criteria) => criteria.fieldCode),
      ].flat()
    ),
  ];
  return fields;
};

export const apply = async (params: {
  condition: PluginCondition;
  /** 値を反映するレコード */
  targetRecord: kintoneAPI.RecordData;
  /** 値を参照するレコード */
  sourceRecord: kintoneAPI.RecordData;
  attachmentProps: AttachmentProps;
  option?: Pick<NonNullable<Parameters<typeof lookup>[0]['option']>, 'enqueueSnackbar'>;
}) => {
  const { attachmentProps, condition, targetRecord, sourceRecord, option } = params;
  const record = { ...targetRecord };

  if (condition.type === 'subtable') {
    return record;
  }

  const dstField = getDstField({ condition, record, rowIndex: attachmentProps.rowIndex });
  if (!dstField) {
    throw new Error('ルックアップ先のフィールドが見つかりません');
  }

  const srcField = sourceRecord[condition.srcField];
  if (!srcField) {
    throw new Error(
      'ルックアップの参照元フィールドが存在しません。プラグインの設定を確認してください。'
    );
  }

  const srcValue = srcField.value;

  dstField.value = convertFieldValueByTargetType({
    targetFieldType: dstField.type,
    sourceField: srcField,
  });
  (dstField as CurrentKintoneField).lookup = true;
  store.set(valueAtLookupAtom(attachmentProps), srcValue);

  (dstField as CurrentKintoneField).error = null;

  for (const { from, to } of condition.copies) {
    const fromField = sourceRecord[from];
    const toField = record[to];
    if (!fromField || !toField) {
      console.error(
        `[${PLUGIN_NAME}] ⚠️ ルックアップ時にコピーするフィールドが見つかりませんでした。プラグインの設定を確認してください。`,
        { fromField, toField }
      );
      continue;
    }

    toField.value = fromField.value;

    if (option && condition.autoLookup && ['SINGLE_LINE_TEXT', 'NUMBER'].includes(toField.type)) {
      setTimeout(() => {
        const { record } = getCurrentRecord()!;
        //@ts-ignore
        record[to].lookup = true;
        setCurrentRecord({ record });
      }, 200);
    }
  }

  store.set(isAlreadyLookupedAtom(attachmentProps), true);
  !isProd &&
    console.log('✨ ルックアップ適用後のレコード', {
      attachmentProps,
      record,
      isAlreadyLookuped: store.get(isAlreadyLookupedAtom(attachmentProps)),
    });
  return record;
};

export const clearLookup = async (params: {
  condition: PluginCondition;
  attachmentProps: AttachmentProps;
}) => {
  const { condition, attachmentProps } = params;
  const { record } = getCurrentRecord()!;
  const originalRecord = clone(record);

  const dstField = record[condition.dstField];
  if (!dstField) {
    throw new Error('ルックアップ先のフィールドが見つかりません');
  }
  clearField(dstField);
  // @ts-expect-error `lookup`プロパティが未定義のため
  dstField.lookup = 'CLEAR';
  // @ts-expect-error dts-genの型情報に`error`プロパティが存在しないため
  dstField.error = null;
  for (const { to } of condition.copies) {
    const field = record[to];
    if (!field) {
      console.error(
        `[${PLUGIN_NAME}] ⚠️ ルックアップ時にコピーするフィールドが見つかりませんでした。プラグインの設定を確認してください。`,
        { field }
      );
      continue;
    }
    clearField(field);

    if (condition.autoLookup) {
      // @ts-expect-error `lookup`プロパティが未定義のため
      record[to].lookup = 'CLEAR';
    }
  }

  store.set(isAlreadyLookupedAtom(attachmentProps), false);
  setCurrentRecord({ record });
  return { originalRecord };
};

const clearField = (field: kintoneAPI.Field) => {
  switch (field.type) {
    case 'SINGLE_LINE_TEXT':
    case 'MULTI_LINE_TEXT':
    case 'RICH_TEXT':
    case 'DROP_DOWN':
    case 'DATE':
    case 'NUMBER':
    case 'CREATED_TIME':
    case 'UPDATED_TIME':
    case 'TIME':
    case 'DATETIME':
    case 'LINK':
      field.value = '';
      break;
    case 'CREATOR':
    case 'MODIFIER':
      field.value = { code: '', name: '' };
      break;
    case 'CATEGORY':
    case 'CHECK_BOX':
    case 'MULTI_SELECT':
    case 'FILE':
    case 'GROUP_SELECT':
    case 'ORGANIZATION_SELECT':
    case 'USER_SELECT':
    case 'STATUS_ASSIGNEE':
    case 'SUBTABLE':
      field.value = [];
      break;
    case 'RADIO_BUTTON':
    case 'STATUS':
      // WIP: 未実装
      break;
    case 'CALC':
    case 'RECORD_NUMBER':
    case '__ID__':
    case '__REVISION__':
    default:
      break;
  }
};
