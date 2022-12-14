import {
	getCurrentInstance,
	inject,
	effectScope,
	reactive,
	computed,
	toRefs,
	watch,
	isReactive,
	isRef,
	isReadonly,
} from 'vue'
import { symbolPinia } from './consts'
import { addSubscription, triggerSubscriptions } from './subscriptions'
// state 管理store中的state
// _s store和对应着id的映射表
// _e 用来停止effect

function isObject(obj) {
	return obj !== null && typeof obj === 'object'
}

function merge(target, state) {
	for (const key in state) {
		let oldValue = target[key]
		let newValue = state[key]
		if (isObject(oldValue) && isObject(newValue)) {
			target[key] = merge(oldValue, newValue)
		} else {
			target[key] = newValue
		}
	}
}

function createSetupStore(id, setup, pinia) {
	let scope
	// 全局可以关闭所有的store,让他停止,自己也有一个scope,可以停止自己
	const setupStore = pinia._e.run(() => {
		scope = effectScope()
		return scope.run(() => setup())
	})

	function $patch(partialStateOrMutator) {
		if (typeof partialStateOrMutator === 'function') {
			partialStateOrMutator(pinia.state.value[id])
		} else {
			merge(pinia.state.value[id], partialStateOrMutator)
		}
	}

	let actionSubscribers = []
	const store = reactive({
		$patch,
		$dispose() {
			scope.stop()
			actionSubscribers = []
			pinia._s.delete(id)
		},
		$subscribe(callback, options = {}) {
			scope.run(() => {
				watch(
					pinia.state.value[id],
					state => {
						callback(state)
					},
					options
				)
			})
		},
		$onAction: addSubscription.bind(null, actionSubscribers), // 绑定数组和用户的回调
	}) // 这里面可以扩展自己的方法
	pinia._s.set(id, store) // 塞入全局

	function wrapActions(actions) {
		return function (...args) {
			let afterList = []
			let errorList = []
			function after(callback) {
				afterList.push(callback)
			}
			function onError(callback) {
				errorList.push(callback)
			}
			triggerSubscriptions(actionSubscribers, { after, onError })
			let result
			try {
				result = actions.call(store, ...args)
			} catch (e) {
				triggerSubscriptions(errorList, e)
			}
			if (result instanceof Promise) {
				return result
					.then(res => {
						triggerSubscriptions(afterList, res)
					})
					.catch(e => {
						triggerSubscriptions(errorList, e)
						return Promise.reject(e)
					})
			}
			// 支持同步和异步
			triggerSubscriptions(afterList, result)
			return result
		}
	}

	const state = {}
	for (const key in setupStore) {
		//这里会触发计算属性取值
		const v = setupStore[key]
		if ((isRef(v) || isReactive(v)) && !isReadonly(v)) {
			// 过滤掉计算属性（计算属性不能存）
			state[key] = v
		}
		if (typeof v === 'function') {
			// 将actions挂载到store上
			setupStore[key] = wrapActions(v)
		}
	}

	Object.assign(store, setupStore)

	if (!pinia.state.value[id]) {
		pinia.state.value[id] = state // compositionApi必须要又个空值
	}

	Object.defineProperty(store, '$state', {
		get() {
			return pinia.state.value[id]
		},
		set(state) {
			$patch($state => Object.assign($state, state))
		},
	})

	// if (!store.$state) {
	// 	pinia.state.value[id] = setupStore
	// }

	store.id = id
	pinia._p.forEach(plugin => {
		scope.run(() => plugin(store))
	})

	return store
}

function createOptionsStore(id, options, pinia) {
	let { state, actions, getters } = options
	function setup() {
		// 后面要实现计算属性等
		pinia.state.value[id] = state ? state() : {}

		const localState = toRefs(pinia.state.value[id]) // 不加toRefs会丧失响应式，Object.assign会拆包合并
		return Object.assign(
			localState,
			actions,
			Object.keys(getters || {}).reduce((memo, key) => {
				//处理getter
				memo[key] = computed(() => {
					// computed有缓存 所以用这个
					const store = pinia._s.get(id)
					return getters[key].call(store, store)
				})
				return memo
			}, {})
		)
	}
	const store = createSetupStore(id, setup, pinia)
	store.$reset = function () {
		const newState = state ? state() : {}
		store.$patch(state => {
			Object.assign(state, newState)
		})
	}
}

export function defineStore(idOrOptions, setup) {
	// id+对象 // ID+setup // 对象
	let id
	let options
	if (typeof idOrOptions === 'string') {
		id = idOrOptions
		options = setup
	} else {
		id = idOrOptions.id
		options = idOrOptions
	}

	const isSetupStore = typeof setup === 'function'

	// 用户使用的函数
	function useStore() {
		const currentInstance = getCurrentInstance()
		const pinia = currentInstance && inject(symbolPinia)
		// 用户多次调用useStore方法,只有第一次是将这个store创建出来,后续都是可以复用的
		if (!pinia._s.has(id)) {
			if (isSetupStore) {
				createSetupStore(id, setup, pinia)
			} else {
				// 将标识和选项放到pinia中
				createOptionsStore(id, options, pinia)
			}
		}
		const store = pinia._s.get(id) // 从全局拿到
		return store
	}
	return useStore
}
